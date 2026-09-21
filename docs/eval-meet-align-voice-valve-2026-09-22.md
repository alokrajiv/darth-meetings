# The pooled-room rule's voice valve: built, measured, shipped OFF

Status: **built and unit-tested; wired into the post-completion flow behind
`MW_MEET_ALIGN_VOICE_VALVE`, default OFF.** On the corpus it was measured
against it does not pay — at the eval's own threshold it rescues one name the
owner's labels call wrong and none that are right — so the flag stays off until
someone re-measures on more data.

Written 2026-09-22 (SGT). The prod extraction ran read-only against
`meeting_whisperer_prod` on the app VM (`azureuser@172.17.0.6`) at
**05:47 SGT** (`SET default_transaction_read_only=on`, `nice -n 15`); the two
embedding passes ran on the same VM at **05:49** and **05:51 SGT**, each in its
own process with its own copy of the ECAPA model — the production voiceprint
sidecar on :3004 was never called. A throwaway copy of the patched sidecar was
started on port **3055** at 05:56–05:58 SGT to prove the new endpoint end to
end, then killed; pm2 was not touched, nothing was deployed, no AssemblyAI or
any other paid call was made, and no row was written.

Scripts and the exported dataset: `tmp/meet-align-valve/`.

No transcript text and no personal name left the database. Names are read only
to build per-row equality CLUSTERS (the same integers the 2026-09-22
dense-windows eval used); per Meet window only the character COUNT is kept.
People appear below as `row <id> / name#<cluster>` and `sp <label>` only. Every
ffmpeg call is `-vn`: **no video frame was decoded**, in the eval or in the
shipped code.

---

## 1. What was asked for

`docs/eval-meet-align-dense-windows-2026-09-22.md` §4 measured the cost of the
pooled-room rule — one Meet name decisively winning ≥ 2 diarized labels means
"several people on one device", so all of its suggestions are dropped:

| | labels dropped | meetings | would have been RIGHT | would have been WRONG |
|---|---|---|---|---|
| shipped (density-weighted) rule | 48 | 16 | 9 | 14 |

and recommended a **release valve**: keep the trigger, but when the row has
local media on the sidecar's own timeline and the name has enough dense speech,
cut 8 × 5 s snippets of that name's own dense windows, embed them with ECAPA,
and take `split` (the best 2-cluster centroid cosine, `docs/eval-shared-mic-
2026-09-21.md` §4). `split ≥ 0.45` = one voice = the rule was a false alarm →
keep the winning suggestion. Below that, no media, or no opinion → drop, as
today. Silence is never read as "single voice".

That is exactly what was built, and then measured on the same 46 prod rows.

---

## 2. Dataset and method

Same scope as the dense-windows eval — every row `suggestSpeakersFromMeet` runs
on: a real AssemblyAI payload (non-`gmeet-` id, ≥ 3 diarized utterances) plus a
stored sidecar with ≥ 3 utterances. **46 rows**, 42 of them with local media.

`plan.py` replays the SHIPPED vote and gates (weight `min(1, d/15)` with a
2 chars/s floor; share ≥ 0.60 and ≥ 20 s of weighted overlap; then the
pooled-room drop) and reproduces §4 exactly: **19 pooled groups over 16 rows,
48 labels dropped, of the 23 with a confirmed name 9 right / 14 wrong.**

For each pooled group it then applies the valve's preconditions:

| precondition | constant | source |
|---|---|---|
| local media exists | — | eval §7 |
| no timeline shift (`combinedParts`, `videoParts`, clips/re-cut) | — | eval §6, row 914 |
| Meet↔AAI alignment | ≥ 0.50 of Meet window ms lands on diarized speech | eval §6 |
| dense windows for that name | span ≥ 3 s **and** ≥ 12 chars/s | eval §2.1 |
| enough of them | ≥ 4 windows **and** ≥ 60 s | eval §3 |
| snippets cuttable | ≥ 4 windows that can yield 5 s | this eval |
| budget | ≤ 3 checks per meeting per pass | this eval |

Outcome over the 19 groups:

| | groups |
|---|---|
| skipped, timeline shifted (`combinedParts` row) | 1 |
| skipped, not enough dense speech | 1 |
| skipped, no media / misaligned / uncuttable / over the cap | 0 |
| **checked** | **17**, in 14 meetings, 134 snippets |

The cap never bound: no meeting has more than 2 pooled groups.

Ground truth is the owner's confirmed `customName`s, as before. A rescue keeps
**one** suggestion — the label holding the most density-weighted time under
that name — so a group can rescue at most one label. Of the 17 checked groups,
9 have a confirmed name on that winning label (6 right, 3 wrong); the other 8
winners were never named by a human and are counted as *unknown*, neither a
measured gain nor a measured loss.

---

## 3. Result: the rooms are really shared

`split` per checked group (L = 5 s, K = 8, the eval's operating point; `truth`
is what the owner's labels say the winning label's name is):

| row | name# | winner | split | min | mean | truth |
|---|---|---|---|---|---|---|
| 191 | 0 | sp C | 0.239 | 0.087 | 0.405 | wrong |
| 195 | 4 | sp A | 0.116 | −0.040 | 0.213 | — |
| 196 | 4 | sp E | 0.363 | 0.119 | 0.327 | — |
| 197 | 4 | sp E | 0.190 | 0.003 | 0.222 | — |
| 306 | 0 | sp A | 0.301 | 0.033 | 0.414 | right |
| 330 | 1 | sp C | 0.120 | 0.014 | 0.226 | right |
| 331 | 2 | sp C | 0.380 | 0.072 | 0.319 | — |
| 332 | 0 | sp A | 0.202 | 0.036 | 0.311 | right |
| 376 | 5 | sp C | **0.712** | 0.357 | 0.562 | wrong |
| 461 | 0 | sp B | **0.809** | 0.572 | 0.674 | — |
| 461 | 1 | sp C | 0.191 | −0.067 | 0.393 | — |
| 462 | 1 | sp B | 0.162 | −0.076 | 0.300 | wrong |
| 462 | 2 | sp D | 0.155 | 0.059 | 0.407 | right |
| 465 | 0 | sp B | 0.257 | 0.004 | 0.355 | — |
| 465 | 1 | sp A | 0.424 | −0.071 | 0.449 | — |
| 702 | 2 | sp A | 0.368 | 0.099 | 0.345 | right |
| 835 | 2 | sp B | 0.369 | 0.078 | 0.442 | right |

**15 of 17 score below 0.45.** The check is behaving exactly as the shared-mic
eval measured it — those Meet names really do have more than one voice under
them — which means there is almost nothing for a release valve to release.

### 3.1 What the valve buys, by threshold

| threshold | fires | rescued | correct | wrong | unknown |
|---|---|---|---|---|---|
| 0.25 | 9 | 9 | 3 | 1 | 5 |
| 0.30 | 8 | 8 | 3 | 1 | 4 |
| 0.35 | 7 | 7 | 2 | 1 | 4 |
| 0.40 | 3 | 3 | 0 | 1 | 2 |
| **0.45** (recommended) | **2** | **2** | **0** | **1** | **1** |
| 0.50 | 2 | 2 | 0 | 1 | 1 |

At 0.45 the valve is **net negative on measured labels**: zero correct rescues,
one wrong one (row 376, `split` 0.712 — one voice in that name's dense windows,
and the vote still hands its top label the wrong person's name). The 9 labels
the rule wrongly suppresses stay suppressed at every threshold ≥ 0.40.

Only at 0.25–0.30 does it rescue correct names (3 right, 1 wrong, 4–5 unknown)
— but that means firing on scores the shared-mic eval measured as *two voices*
(shared-mic median 0.25, single-voice p10 0.54), i.e. deliberately overriding a
check that is saying "shared mic". That is not a release valve, it is switching
the rule off for the half of the corpus with audio.

### 3.2 Why: the rule is not false-alarming

A second, cheap measurement settles it (`embed_labels.py`, 50 s of VM CPU).
For each pooled group, embed every AAI label in it from **its own diarized
utterances** and take the cosine between the label centroids. High = AssemblyAI
over-split one person and the whole group deserves the name; low = genuinely
different people behind one device. This is `docs/eval-shared-mic-2026-09-21.md`
§3.2's test, applied to the rule's own decisions.

Minimum label-pair cosine per group: **−0.11 – 0.56, median 0.17**. Only one
of the 18 measurable groups (row 835, name#2, 0.557) looks like one person
split in two — and keeping that group's whole name would score 1 right and
1 wrong, because the other label under it is confirmed as somebody else.

So the pooled-room rule is right about the *room* essentially every time. Its
9 "would have been right" labels are not false alarms: they are shared rooms in
which the Meet display name happens to belong to the loudest voice. The
question the valve asks ("is this name one voice?") is not the question the
lost coverage turns on ("which of the voices in this room owns the name?"), and
no threshold on `split` can convert one into the other.

---

## 4. Decision

**Ship the valve, default OFF** (`MW_MEET_ALIGN_VOICE_VALVE`).

* The mechanism is correct, cheap and now proven end to end (§5), so it costs
  nothing to keep and one env var to try again later.
* On this corpus it rescues 0 correct and 1 wrong name, so turning it on today
  would be a small, measurable regression in precision.
* The corpus is small (23 dropped labels with a confirmed name, 9 measurable
  winners) and skewed to Doc-derived sidecars. If the fleet gains many more
  Meet-API rows, re-run §3 before deciding again.
* If anyone does turn it on, keep the threshold at **0.45**. 0.40 and below buy
  coverage only by ignoring a check that says "two voices".

What would actually recover that coverage is a different feature, and this eval
says what it is: not "is the name one voice?" but "**which** voice in this room
is the name?" — i.e. match each of the group's labels against enrolled
voiceprints (`suggestSpeakersForTranscript` already does exactly this, and its
suggestions already outrank overlap votes), or ask the owner once. That is not
built here.

---

## 5. Cost, and what the VM needs

| | measured |
|---|---|
| one check (8 × 5 s snippets: ffmpeg seek + slice + ECAPA) | **1.1 – 1.3 s** of VM CPU |
| 17 checks, 134 snippets, model resident | **20 s wall**, `nice -n 15`, 3 torch threads |
| worst case per meeting at the shipped cap (3 checks) | **~4 s**, inside the fire-and-forget post-completion hook |
| the label-vs-label probe of §3.2 (not shipped) | 50 s for all 19 groups |

**The sidecar needs nothing new installed** — no new Python package, no new
model, no new pm2 app. `voiceprint/server.py` gains one endpoint
(`POST /embed-batch`) using the same numpy/torch/speechbrain that `/embed` has
always used. It does need to be **deployed and restarted** for the valve to work
at all; until then the valve's calls 404, which `runVoiceValve` treats as "no
opinion" — i.e. today's behaviour. That is the safe ordering: the flag can only
be turned on after the sidecar is restarted, and turning it on before that
changes nothing.

Proven live at 05:57 SGT against a throwaway copy of the patched sidecar on
port 3055 (the prod one on :3004 kept running, untouched): `POST /embed-batch`
with row 376's 8 snippets returned HTTP 200 in **1.17 s** with 8 × 192-dim
embeddings, and the shipped TypeScript `splitScore` over them gives **0.712** —
the same number numpy computed offline.

---

## 6. What was built

* **`src/lib/meet-align-valve.ts` (new, pure, no `server-only`)** — the whole
  decision: `denseWindowsFor` (the eval's hard 12 chars/s × 3 s cut, on the
  same `windowDensity` the vote weights with), `timelineAlignment`,
  `pickSnippetWindows` / `snippetsFor` (a port of the eval's spread-across-the-
  meeting picker), `planValveChecks` (preconditions, ordering by dense speech,
  the 3-per-meeting cap), `splitScore` (the eval's `stats_for`, partition
  enumeration and small-n fallback included), `verdictFor` and `runVoiceValve`,
  which takes the embedder as an argument so the sidecar can be stubbed.
* **`src/lib/__tests__/meet-align-valve.test.ts` (new)** — 28 cases: every skip
  reason, the cap, the winner rule, the split statistic (including why `split`
  survives a single outlier where `min` does not), the threshold, and that a
  throwing sidecar or too few decoded snippets is "no opinion" and never a
  rescue.
* **`src/lib/meet-align-vote.ts`** — `windowDensity` extracted (lines 76–88) so
  the soft weight and the valve's hard cut read one definition. No behaviour
  change; the vote's own tests still pass.
* **`src/lib/server/meet-align.ts`** — `voiceValveEnabled()` (line 76, the flag,
  default off), `timelineShifted()` (line 88), `runPooledRoomValve()` (line
  107, the sidecar wiring and the log lines), and the pooled-room loop now
  collects the groups it drops (line 203; the rescue set at 221) so the valve can consult them. A
  rescued speaker keeps `source: 'context'` — that field is the People card's
  filter key, which another change owns — and says what happened in its
  `evidence` sentence (`…the shared-device guard was released
  (meet-align+voice)`).
* **`src/lib/server/voiceprint.ts`** — appended `embedSegmentsViaSidecar`: one
  embedding per segment, `[]` on nothing usable, never a partial verdict.
  Nothing is enrolled and nothing is written.
* **`voiceprint/server.py`** — appended `POST /embed-batch` (`embed_segments` +
  `slice_audio_only`, which passes `-vn` explicitly). `/embed` and `/align` are
  untouched.
* **`src/lib/server/post-completion.ts`** — the one call site passes
  `{ media: resolved.media, gmeetContext: full.gmeet_context }`. Everything
  else about the hook is unchanged, and it is still fire-and-forget.

One log line per check, e.g.

```
[meet-align] <id>: voice valve "<name>" split=0.712 (8 snippets, 11 dense windows, 214s) -> single-voice
[meet-align] <id>: voice valve skipped "<name>" (not-dense, alignment 0.91)
```

### 6.1 The shipped TypeScript reproduces these numbers

`tmp/meet-align-valve/verify.ts` runs the real `planValveChecks` over the
exported rows and the real `splitScore` over the embeddings the VM produced:
**17 planned checks (Python: 17), identical winners, dense-window counts and
snippet starts, 17/17 split values reproduced, 2 verdicts of `single-voice`.**

---

## 7. Caveats

* **Small sample, and it is the sample that matters.** 19 pooled groups, 23
  dropped labels with a confirmed name, 9 measurable winners. A handful of new
  Meet-API rows could move §3.1 either way.
* **The "unknown" winners.** 8 of the 17 checked groups have no confirmed name
  on the label the valve would keep. They are neither counted as gains nor as
  losses; if they are mostly right the valve looks better than §3.1 says, if
  mostly wrong, worse.
* **Ground truth is partly the old algorithm's own output** — the People card's
  one-click accept — exactly as in the dense-windows eval §2.
* **`split` is measured on the NAME's dense windows only.** Row 376 is the
  proof that this is not the same as "the two labels are one person": one voice
  fills that name's dense windows and the top label still belongs to somebody
  else. §3.2 measures the other question directly.
* **Doc-derived sidecars dominate.** Of the 17 checked groups only a few come
  from Meet API entries; the dense cut lands differently on interpolated Doc
  blocks, and no Teams VTT row reaches this code at all.
* **The check is blind where it matters most.** A room's quiet second person
  produces few dense windows, so the name goes to "no opinion" — which is the
  right answer here (drop), but it means the valve is silent exactly where a
  shared mic is hardest.
* **Nothing is enrolled, ever.** The embeddings live for the length of one
  check. No `voiceprints` row is written, read or compared against.

---

## 8. Reproducing

```
tmp/meet-align-valve/
  extract.py       pull the 46 rows (cluster ints, char COUNTS, media name)
  plan.py          shipped vote + gates + pooled drop + valve preconditions
  embed_valve.py   the check itself: 8 x 5 s snippets -> ECAPA -> split
  embed_labels.py  the §3.2 probe: are the group's AAI labels one voice?
  score.py         rescue table, threshold sweep, what stays suppressed
  score_labels.py  the same for the §3.2 signal
  verify.ts        re-run the SHIPPED TypeScript over the same rows
  data/            rows.json, candidates.json, splits.json, labelpairs.json
```

On the VM, read-only:

```
cd /temphigh/tmp-workspace/meet-align-valve
set -a; . ~/apps/meeting-whisperer/.env.local; set +a
nice -n 15 python3 extract.py data
nice -n 15 ~/.mw-voiceprint/venv/bin/python embed_valve.py data     # needs candidates.json
nice -n 15 ~/.mw-voiceprint/venv/bin/python embed_labels.py data
```

then, offline on the laptop:

```
python3 plan.py data
python3 score.py data 0.25 0.30 0.35 0.40 0.45 0.50
python3 score_labels.py data
bun run tmp/meet-align-valve/verify.ts
```

`embed_valve.py` and `embed_labels.py` read the model from a **copy** at
`/temphigh/tmp-workspace/meet-align-valve/model` (symlinks into the shared
HuggingFace cache, taken from `~/.mw-voiceprint/model`) so nothing touches the
running sidecar, read media read-only from
`~/apps/meeting-whisperer/storage/audio`, and write only inside the scratch
directory.
