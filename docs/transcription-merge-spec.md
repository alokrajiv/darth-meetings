# Mixed-language recordings — helper runs, merged versions, CLI verbs

**Date:** 2026-10-13 (SGT) · **Asked by:** Alok · **Builds on:** Phase 2 transcription versions
(`docs/recordings-phase2-spec.md`, migration 046, `MW_TRANSCRIPTION_VERSIONS=1` live in prod) and the
2026-09-21 eval (`docs/eval-aai-code-switching-2026-09-21.md`).

## Why

AssemblyAI picks ONE language per file. On an English+Indonesian call:

- auto-detect → `en` (meeting 59867f2b…, row 1134: `language_confidence` 0.28) → every Indonesian turn
  comes out as invented Vietnamese / Thai / Hindi (34 such lines in a 31-min call);
- forced `id` → Universal-2 (3.5 Pro has no Indonesian) → Indonesian is clean and natural, but English
  turns are TRANSLATED into Indonesian;
- `language_detection_options.code_switching` / `language_codes:["en","id"]` → no-op for `id`.

Each pass is right exactly where the other is wrong, and the English pass's own word confidence tells
them apart: 0.85–0.98 on English, < 0.75 on the garbled Indonesian (30-s buckets, row 1134). A merge
that keeps the base pass and swaps in the fill pass on low-confidence spans was prototyped on row
1134 offline: 0 non-Latin/Vietnamese lines left (34 before), all Indonesian turns readable, English
kept, plus a stretch the report had missed (18:55–20:00) recovered. Cost of the extra pass ≈ $0.08 per
31 min.

The data model already supports it: a RECORDING holds many `recording_transcriptions` (versions), one
is active, meetings show the active one. What is missing: (1) a run that does NOT replace the active
version, (2) a merged version, (3) recording-level routes for recordings that are not in a meeting,
(4) CLI verbs, (5) a health signal so an agent knows when to do this.

## Vocabulary

- **base** — the version kept as the skeleton (speakers, utterance boundaries, indices). Normally the
  English / auto-detect version.
- **fill** — the version whose words replace the base on low-confidence spans. Normally the forced
  `id` (or `zh`, …) version.
- **merged version** — a `recording_transcriptions` row with `provider = 'merge'`, `status =
  'completed'`, no provider job, payload computed on our server.

## 1. Pure merge — `src/lib/transcript-merge.ts` (+ `__tests__`)

```ts
export interface MergeOptions {
  utteranceThreshold?: number; // default 0.75 — whole utterance swapped when its mean word conf < this
  wordThreshold?: number;      // default 0.75 — rolling-mean threshold for partial spans
  window?: number;             // default 6 — rolling window (words), centred
  minRun?: number;             // default 6 — a partial span must be >= this many base words
  island?: number;             // default 4 — good islands of <= this many words between bad words are absorbed
}
export interface MergeStats {
  utterances: number; utterancesTouched: number; utterancesWhole: number;
  swappedMs: number; durationMs: number; fillWordsUsed: number;
}
export function mergeTranscripts(base: TranscriptResponse, fill: TranscriptResponse, opts?: MergeOptions):
  { payload: TranscriptResponse; stats: MergeStats };
```

Algorithm (reference prototype that produced the numbers above — port it faithfully):

```
for each base utterance u (words ws, n = len):
  mean = avg(ws.confidence)
  if mean < utteranceThreshold:
      span = [u.start, u.end)                      -> whole-utterance swap
  else:
      bad[i] = rollingMean(ws, i, window) < wordThreshold
      absorb good islands: a run of !bad of length <= island with bad on BOTH sides -> bad
      spans = runs of bad with length >= minRun;
              span = [ws[i].start (or u.start if i==0), ws[j].start (or u.end if j==n))
  for each span: fillWords = fill.words whose MIDPOINT (start+end)/2 is in [lo, hi)
      if fillWords is empty -> keep the base words (conservative; never blank a line)
      else replace the base words in the span with fillWords, each re-labelled speaker = u.speaker
```

Midpoint assignment means a fill word lands in at most one span (no duplicates at boundaries).

Output payload = a deep copy of `base` with:
- `utterances`: SAME count, order, `speaker`, `start`, `end` as the base (load-bearing: utterance
  edits are keyed by index and speaker names by the base's diarization labels — both stay valid).
  `words` rewritten, `text` = words joined with single spaces (AAI word texts carry punctuation),
  `confidence` = mean of the new words. Touched utterances get `merged: true`; swapped words get
  `source: 'fill'` (extend the TS types as optional fields).
- top-level `words` = flatten of utterance words; `text` = utterance texts joined; `confidence` = mean.
- `language_code`, `speech_model_used`, detection fields: the base's (unchanged).
- new top-level `merge: { baseTranscriptionId, fillTranscriptionId, fillLanguage, options, stats }`
  (the route fills the ids; the pure function leaves them for the caller).

Tests use SYNTHETIC fixtures only (no customer text in the repo): English utterances at 0.95, a
garbled utterance at 0.5 (whole swap), an English utterance with a 7-word 0.4 run in the middle
(partial swap), a 2-word dip (NOT swapped), an island case, an empty-fill case (kept), boundary-word
dedupe, index/speaker preservation, stats.

## 2. Health signal — `src/lib/transcript-health.ts` (pure)

```ts
export interface TranscriptHealth {
  asrConfidence: number | null;      // payload.confidence
  languageConfidence: number | null; // payload.language_confidence
  lowConfidenceShare: number;        // share of AUDIO time in utterances with mean word conf < 0.75
  foreignScriptShare: number;        // share of utterances containing Thai/Devanagari/CJK/Vietnamese-
                                     // specific diacritics when payload language is en* (0 otherwise)
  mixedLanguageSuspected: boolean;   // lowConfidenceShare >= 0.10 || foreignScriptShare >= 0.03
                                     //   || (languageDetected && languageConfidence < 0.5)
}
export function transcriptHealth(payload: TranscriptResponse): TranscriptHealth;
```

Row 1134 must come out `mixedLanguageSuspected: true`; a clean English synthetic fixture `false`.

## 3. Server

### 3a. Run modes on `POST /api/transcripts/:id/retranscribe` (version mode only)

Body gains `mode?: 'replace' | 'helper' | 'merge'` (default `'replace'` = today's behaviour) and
`mergeOptions?: MergeOptions`. Stored on the run: `requested.mode`, and for `'merge'`
`requested.mergeBase = <the active transcription id at start>`, `requested.mergeOptions`.

In `pollOnce` (`src/lib/server/transcription-runs.ts`) after `completeRunTranscription`:
- `replace` → `activateTranscription` (unchanged).
- `helper` → do NOT activate; clear the marker; log "kept as helper".
- `merge` → load base payload (`requested.mergeBase`) + the new payload, `mergeTranscripts`, insert the
  merged version (3b), activate the MERGED version. If the base is gone/not completed, fall back to
  `helper` and log why — never activate the raw fill (it would translate the English).

`sameTranscriptionSettings` 409 must not fire for `helper`/`merge` with a different language (it
already only fires on same model+language; keep `force`).

### 3b. Merged versions

`insertMergedTranscription({ recordingId, base, fill, payload, requested, covers })` in
`src/db-ops/transcriptions.ts`: `provider='merge'`, `status='completed'`, `provider_job_id=NULL`,
`speech_model=NULL`, `language_code` = base's, `covers` = base's, `completed_at=now()`,
`requested = { by, at, reason, merge: { base, fill, fillLanguage, options, stats } }`.

**Annotation carry-over** (so speaker names and edits are not lost): at creation, copy the BASE's
annotations to the merged id in `transcription_annotations` — from the live tables
(`transcript_edits` / `speaker_mappings`, every user's rows for every meeting on the recording, the way
`applyActivatePlan` parks them) when the base is the active version, else from the base's parked rows.
Activation then restores them through the existing path. Indices and labels are identical by
construction (§1), which is what makes this safe.

`applyRecordingGraph` / any sweep that deletes transcriptions must leave `provider='merge'` rows alone
(they carry `requested`, which already protects them — verify).

Routes (editors of the meeting; same `resolveAccess` gate as retranscribe):
- `POST /api/transcripts/:id/transcriptions/merge` body
  `{ base: tid, fill: tid, options?: MergeOptions, reason?: string, activate?: boolean, dryRun?: boolean }`
  → 400 unless both are completed versions OF THIS meeting's recording and differ;
  `dryRun` → 200 `{ dryRun: true, stats, preview: [{ start, speaker, before, after }] }` (touched
  utterances, max 40, texts truncated to 300 chars), nothing written;
  else → 201 `{ ok: true, transcriptionId, stats, activated: boolean }`.
- `GET /api/transcripts/:id/transcriptions/:tid/content` → readers: `{ transcriptionId, active,
  utterances: [{ start, end, speaker, text, merged? }], languageCode, provider }` — so an agent can read
  a NON-active version before deciding. Speaker = diarization label; when the version's labels equal
  the active version's (merged-from-active, or the active itself) apply the caller-visible confirmed
  names the same way `text` does.

`TranscriptionVersion` (src/lib/transcriptions.ts) gains `asrConfidence: number | null`,
`health: TranscriptHealth | null` (computed in SQL-light way: you may load payloads for completed
versions here, the list is small — but cap at 6 versions per call), and
`merge: { base, fill, fillLanguage, stats } | null`. Web: the existing Versions list shows provider
`merge` as "Merged — <base lang> + <fill lang>"; nothing else in the UI is required in this pass.

### 3c. Recording-level routes (recordings that belong to no meeting)

Owner-only (`recordings.owner` = caller — reuse whatever `src/app/api/recordings/[id]/route.ts`
gates on; 404 for anyone else, never 403):
- `GET  /api/recordings/:id/transcriptions` → same `TranscriptionsResponse` shape.
- `POST /api/recordings/:id/transcribe` → same body as retranscribe (`languageCode`, `speechModel`,
  `reason`, `force`, `mode`, `mergeOptions`).
- `POST /api/recordings/:id/transcriptions/merge` → same as 3b.
- `POST /api/recordings/:id/transcriptions/:tid/activate` → sets `recordings.active_transcription_id`.
- `GET  /api/recordings/:id/transcriptions/:tid/content`.

If the recording IS used by a meeting, the write routes answer 409 `{ error, meetingId }` ("use the
meeting's routes — switching versions there moves the meeting's annotations"); the reads still work.

Runs on a bare recording have no meeting row to hold the `gmeet_context.retranscribing` marker. Track
them by the transcription row itself: the sweeper additionally polls
`recording_transcriptions WHERE status='processing' AND provider_job_id IS NOT NULL AND requested IS
NOT NULL AND NOT EXISTS (meeting_clips on that recording)` and completes them with the same
`mode` handling (activation = set `active_transcription_id`). Keep the existing per-meeting path
untouched for meetings. If this proves larger than expected, ship 3a/3b first and leave 3c's writes
behind a clear 501 — say so in the report.

### 3d. Tests + build

Unit tests for §1/§2 and for any pure decision you add (mode handling). `bun run test` (or the repo's
test script) and `bun run build` with NO PG/AAI env must pass (`feedback_build_envvars`). No
migration should be needed (`requested` is jsonb, `provider` is free text) — if one turns out to be
needed, write it as `migrations/058_*.sql` following the header convention and STOP to report.

## 4. darth-cli (meetings family, `cli-subcommand-src/index.ts`)

```
meetings transcriptions <id> [--json]
    versions newest first: ▶ active, provider/model actually run, language (detected 0.28 | forced),
    ASR conf, speakers, status, merge info, reason; then a HEALTH line for the active version and,
    when mixedLanguageSuspected, the exact command to run next.
meetings text <id> --version <tid>          (existing `text` + read a non-active version)
meetings transcribe-again <id> [--language <code|auto>] [--model <m>] [--reason "…"]
        [--keep-active | --merge] [--merge-threshold 0.75] [--force] [--wait [--timeout <mins>]]
    --keep-active = mode helper; --merge = mode merge (the one-shot fix: "this call is English +
    Indonesian" = `transcribe-again <id> --language id --merge --wait`). --wait polls the versions
    list every 10 s until the run is no longer running, then prints the final state (and the merged
    version when --merge). Exit 0 completed, 1 error, 3 timeout (still running).
meetings merge-transcriptions <id> --base <tid> --fill <tid> [--threshold 0.75] [--dry-run] [--activate]
meetings use-transcription <id> <tid>
meetings recordings transcriptions|text --version|transcribe-again|merge-transcriptions|use-transcription <rid> …
    same verbs on the recording routes (owner only).
```

Help text + README rows + the `meetings skill` gets a section **"Mixed-language recordings"**:
symptom (garbled foreign script / low confidence / report says it relied on the English parts) →
`transcriptions <id>` → `transcribe-again <id> --language <code> --merge --wait` → read `text`,
spot-check, `use-transcription` back if worse → regenerate notes/report as the CLI already allows.
State the cost (~$0.17/h per extra pass) and that a forced language on its own TRANSLATES the other
language (never `--language id` without `--merge` or `--keep-active` on a mixed call).

## Out of scope (ask Alok later)

Automatic second pass at ingest when `mixedLanguageSuspected` (needs a per-org/series default
language — which one to try is a guess today); a UI button for merge; non-AAI providers.
