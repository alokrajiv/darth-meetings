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

## Amendment A (2026-10-13, after live probes — BINDING, overrides §3a/§4 where they differ)

Probes on a synthetic 70-s en+id clip and a real Indonesian-heavy 5-min slice of row 1134:

| request | result on Indonesian speech |
|---|---|
| auto-detect, Indonesian majority | lands on `id` → Universal-2 → English turns TRANSLATED or DROPPED (synthetic: opening English line vanished) |
| 3.5 Pro forced `language_code:"en"` | DROPS speech: 351 words, 201 s of 280 s covered (−28%) → holes the merge cannot fill |
| 3.5 Pro `language_detection:true` + `language_detection_options:{expected_languages:["en"]}` | 959 words, 280 s covered, Indonesian garbled but present → the right BASE |

1. **New language choice `'auto-en'`** (accepted by retranscribe / recording transcribe, stored in
   `requested.languageCode`): submit `speech_models:["universal-3-5-pro"]`, `language_detection:true`,
   `language_detection_options:{expected_languages:["en"]}`, keyterms allowed (English). This is the
   English base pass. Never recommend forced `en` for a mixed call.
2. **Merge orientation is by language, not by "active at start".** When a `merge`-mode run completes,
   among {the version active at start, the new version}: base = the one whose `language_code` starts
   with `en` (prefer the one that RAN on universal-3-5-pro); fill = the other. Both en / neither en →
   do not merge: keep the new one as a helper and log why. Store the chosen ids in
   `requested.merge`. So both of these work:
   - active is English (auto landed on en): `transcribe-again <id> --language id --merge`
   - active is Indonesian (auto landed on id, e.g. row 920): `transcribe-again <id> --language auto-en --merge`
3. The explicit merge route keeps `base`/`fill` as given, but `dryRun` (and the 201) return
   `warnings: string[]` — e.g. "base is not an English version", "fill is English".
4. CLI: `--language` accepts `auto-en`; `transcriptions` suggests `--language <code> --merge` when the
   active version is en*, `--language auto-en --merge` when it is not; skill text says forced `en`
   drops the other language's speech (−28% in the probe) and forced `<other>` translates English.

## As-built — server (§1–§3), 2026-10-13

Built on branch `merge-server` against this spec **plus Amendment A** (commit `44501d8`, read from that
commit; it was not cherry-picked into this branch, so merge the two spec edits together). Route paths,
bodies and response shapes are as specified; the additions below are all additive.

**Files.** Pure: `src/lib/transcript-merge.ts` (§1), `src/lib/transcript-health.ts` (§2),
`src/lib/transcription-merge-plan.ts` (mode/option parsing, Amendment A orientation + warnings, label
spaces, content rows). Server: `src/lib/server/transcription-runs.ts` (modes, merge landing, explicit
merge), `src/lib/server/recording-transcriptions.ts` (§3c), `src/lib/server/transcription-content.ts`
(version content), `src/lib/server/merge-request.ts`. DB: `src/db-ops/transcriptions.ts`. No migration.

**Deviations and decisions (read these before building on it):**

1. **Orientation by language (Amendment A §2).** A merge-mode run stores `requested.mergeBase` = the
   active id at start, but on landing `orientMerge` picks base = the `en*` one of {active-at-start, new
   run}; both or neither English → helper + log line. The merged version's `requested.merge` records
   `{ base, fill, fillLanguage, options, stats, fromRun }`. The 3.5-Pro preference has nothing to choose
   between when exactly one side is English, so it only shows up in the explicit-merge warnings.
2. **`'auto-en'`** (Amendment A §1) is accepted by both run routes: `language_detection: true`,
   `language_detection_options: { expected_languages: ["en"] }`, `speech_models: ["universal-3-5-pro"]`
   (no Universal-2 fallback), keyterms kept; the model is forced to 3.5 Pro whatever was asked.
   `TranscriptionVersion.languageRequested` (new) is what lets `sameTranscriptionSettings` tell
   `auto-en` from `auto`. **Not verified against AssemblyAI from this branch** (no AAI calls allowed) —
   the SDK is assumed to pass `language_detection_options` through untouched (`as never` cast).
3. **Run-start responses** keep `mode: 'version'` (it names the PATH); the run's own mode is a new
   `runMode` field. `running.mode` is also on the marker / `RunningTranscription`.
4. **Strict parsing:** an unknown `mode` or a bad `mergeOptions` / `options` field is a 400 naming the
   field (never a silent `replace`). `mode` ≠ `replace` on a meeting that falls back to the pre-Phase-2
   new-row path is a 409 (that path IS a replace).
5. **Merged versions are never "brand new"** (`TranscriptionFacts.derived`, `planActivate`): activating
   one does not reset `speaker_id_status`, re-run speaker ID/voiceprints, or send the "transcript ready"
   DM — its labels are its base's. Consequence: a merge-mode run that lands sends no ready DM.
6. **Meeting row model** after activating a merged version = `COALESCE(speech_model,
   payload.speech_model_used)` (the base's model), not NULL; `aai_job_id` becomes NULL (it ran nowhere).
7. **Annotation carry-over is a snapshot** taken when the merged version is written. Edits/names made
   on the base after that stay with the base. All-empty (no edits, no mapping) pairs are not copied.
8. **DEC-4 for unactivated jobs:** helper runs, merge fills and every bare-recording run delete their own
   AAI job on landing (`deleteRunJobAtAai`, behind `MW_AAI_DELETE_ON_COMPLETE`) and stamp
   `provider_deleted_at` — the meeting-side delete only ever sees the meeting row's job.
9. **Bare-recording runs are found by `requested.scope = 'recording'`**, not by "no meeting clips it":
   a run started before the owner made a meeting of the recording is still polled to the end; it then
   lands as a version (and, for merge, a merged version) but is NOT switched to — the meeting's routes
   own that. Double-start guard = conditional insert under a row lock on `recordings`.
10. **Versions GETs poll an in-flight run once** before answering (meeting route via
    `pollTranscriptionRun`, recording route via `pollRecordingRun`; both deduped with the sweeper), so
    `transcribe-again --wait` sees a landing within one 10-s tick instead of the 5-min sweeper.
11. **Health:** `lowConfidenceShare` denominator = speech time (sum of utterance durations), not file
    length; "CJK" includes Hangul and kana; a payload carrying `merge` is never
    `mixedLanguageSuspected` (it is the remedy; its shares are still reported). Row 1134 is flagged by
    its detection confidence alone (auto `en` at 0.28 < 0.5); verified only with a synthetic fixture of
    that shape — no customer data was read.
12. **Version content goes through the meeting's clips** (`resolveMeetingContentForVersion`): a meeting
    holding a window of a recording never serves the rest of it on another version. In compat (one
    whole-recording clip) it is the version's payload verbatim. Names = the owner's confirmed names (what
    `/speakers` shows readers) only when label spaces match (merge chains walk to their root base).
13. **Explicit merge extras:** `warnings` also say "base and fill are in the same language" and "base
    ran on <model>, not universal-3-5-pro". With `activate: true`, a failed activation still answers 201
    with `activated: false` and a `not activated: …` warning (the merged version was written). A dry run
    on a recording a meeting holds is allowed (it writes nothing); `activate` is refused (409) while a
    run is in flight, like "Use this version".
14. **Recording activate** answers the meeting shape with zero `setAside` / `restored`; 409 for "already
    active" and for anything that is not a completed version of the recording.
15. **Graph safety (verified by reading):** the only re-derivation delete (`applyRecordingGraph`
    promotion, `db-ops/recordings.ts`) skips recordings holding a transcription with `requested IS NOT
    NULL`, which every merged row has. The two deletes that DO take merged rows are a permanent meeting
    delete of the last clip holder and a standalone purge — both delete the whole recording on purpose.

**Verified on a scratch Postgres** (`scripts/scratch-db.sh`, 000…057, synthetic rows, AssemblyAI not
called): versions list with `health` / `asrConfidence` / `languageRequested` / `merge`; dry run writes
nothing; explicit merge writes the `merge` row (no job, base language + covers) and carries the base's LIVE
edits + names over; version content applies names on the merged version and not on the fill, and 404s a
version of another recording; activating the merged version leaves the live edits identical, parks the
base's copy, nulls `aai_job_id`, keeps the base model, moves the pointer; a landed merge-mode run on an
Indonesian active version takes the auto-en run as base, and refuses both-non-English; two concurrent
`insertRecordingRun` calls → exactly one wins; the in-flight list needs a job id;
`setRecordingActiveTranscription` moves the pointer, speaker count and `superseded_by`, and refuses a
foreign version and a recording a meeting holds.

**Not verified:** the pollers end to end (they need an AssemblyAI job); no live AssemblyAI call for
`auto-en`; the route handlers themselves were built, not curl-ed; no browser pass of the
"Merged — X + Y" Versions line.

## Amendment B (2026-10-13, after running the TypeScript merge on row 1134's two passes)

Partial spans use a stricter bar than whole utterances: `wordThreshold` default **0.65**
(`utteranceThreshold` stays 0.75). At 0.75 the merge swapped English the base pass was merely unsure
of ("Hendra already fixed and I already update", word confs 0.47–0.51) for its Indonesian
translation. Each rolling-mean run is then GROWN outward over words individually below the bar, so
the garbled edge words a stricter bar would leave are still swapped. Result on row 1134: every
English span kept, 1 short foreign-script fragment left (was 34), merged health not flagged. The CLI
`--threshold t` sends `{utteranceThreshold: t, wordThreshold: t − 0.10}`.
