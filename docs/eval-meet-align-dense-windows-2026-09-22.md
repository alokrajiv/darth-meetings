# Meet↔AAI speaker alignment: weight each window by how full it is

Status: **shipped.** `src/lib/server/meet-align.ts` now votes through a new
pure module, `src/lib/meet-align-vote.ts`.

Written 2026-09-22 (SGT). The prod extraction ran read-only against
`meeting_whisperer_prod` on the app VM (`azureuser@172.17.0.6`) at
**2026-09-22 00:48–00:50 SGT** under `nice -n 15`; every scoring run after that
was offline on the exported file. No writes, no pm2 restart, no AssemblyAI or
any other paid call, no media touched, no video frame decoded.

Scripts and the exported dataset: `tmp/meet-align-eval/`.

No transcript text and no personal name left the database. `extract.py` reads
names only to build per-row equality CLUSTERS (a Meet display name, a confirmed
`customName` and a stored suggestion that mean the same person get the same
small integer) and writes only the integers; per Meet window it keeps the
character COUNT, never the characters. People appear below as
`row <transcript id>` only.

---

## 1. What was wrong

`suggestSpeakersFromMeet` takes the meeting's own named transcript
(`gmeet_context.meetTranscript.utterances`) and, for each AssemblyAI speaker,
sums **wall-clock overlap** against each name's windows. Whoever wins ≥ 60% of
the voted time with ≥ 20 s of overlap names that speaker.

That assumed the windows are speaker turns. They are not, and
`src/lib/format.ts` said so out loud — `MeetTranscriptEntry` was documented as
"precise per-utterance times". The shared-mic eval
(`docs/eval-shared-mic-2026-09-21.md` §2) measured 10,498 Meet API entries:
median span **26 s**, exactly contiguous per participant, so one name's caption
stream tiles their whole session and different names' windows overlap each
other a median **88%** of the time. The median entry carries **5.9 chars/s**
against ~15 chars/s of continuous speech — the attributed person filled about
40% of their own window. `utterancesFromEntries` then merges consecutive
same-speaker entries, making the windows longer still.

The sidecar has three producers and they do not behave alike, which the fix has
to survive. Measured over the 46 prod rows this code actually runs on
(`tmp/meet-align-eval/diag.py`):

| | rows | windows | median span | median density | cross-name overlap (median / p90) |
|---|---|---|---|---|---|
| Meet API entries (`actuals.transcriptEntries`) | 12 | 2,418 | 27.7 s | 5.1 c/s | **0.40 / 0.92** |
| Meet transcript Doc (char-weight interpolation inside 5-min blocks) | 34 | 10,732 | 2.6 s | 13.3 c/s | 0.04 / 0.18 |

(Teams VTT cues are the third producer — real turn-level cues — but no Teams row
in prod currently reaches this code path, so they are untested here.)

So the damage is concentrated on the API-entry source, and any fix that
penalises the Doc source pays for it there.

---

## 2. Dataset and ground truth

Every prod row `suggestSpeakersFromMeet` would run on: a real AssemblyAI payload
(non-`gmeet-` id, ≥ 3 diarized utterances) plus a stored sidecar with ≥ 3
utterances. **46 rows** (12 API-entry, 34 Doc-derived), none deleted.

**Ground truth = the owner's confirmed names** —
`speaker_mappings.speaker_labels[].customName`, non-empty. 151 confirmed labels
resolve to a name the sidecar also knows; 0 do not.

Two honest caveats about that truth:

* **It is partly contaminated by the old algorithm.** The People card offers a
  one-click confirm on a suggestion, so an accepted suggestion becomes ground
  truth. 14 of the 151 confirmed labels already carry a stored
  `source: 'context'` suggestion equal to the confirmed name — an upper bound on
  accept-clicks, and all of it flatters the OLD algorithm. Every table below
  therefore also reports the "clean" subset with those 14 removed.
* Name matching is a conservative per-row cluster (identical after
  normalisation, one a token-subset of the other, or first name + last initial).
  Both algorithms are scored through the same clusters, so it cannot favour
  either.

Metrics, per (row, AAI label) with a confirmed name: **coverage** = a decisive
suggestion was emitted; **precision** = of those, the fraction matching the
confirmed name; **wrong-confident** = emitted and wrong. The decisive gate and
the pooled-room drop are applied exactly as `meet-align.ts` applies them.

---

## 3. Old vs new

`old` is today's flat overlap. `new` is the shipped rule:

> a window is worth `min(1, chars / (15 × span_s))` of its duration, and worth
> **nothing** below 2 chars/s.

| | truth labels | emitted | correct | wrong | precision | coverage |
|---|---|---|---|---|---|---|
| **ALL 46 rows — old** | 151 | 101 | 95 | 6 | 0.94 | 0.67 |
| **ALL 46 rows — new** | 151 | **112** | **107** | **5** | **0.96** | **0.74** |
| API-entry rows — old | 26 | 3 | 2 | 1 | 0.67 | 0.12 |
| API-entry rows — new | 26 | **14** | **13** | **1** | **0.93** | **0.54** |
| Doc-derived rows — old | 125 | 98 | 93 | 5 | 0.95 | 0.78 |
| Doc-derived rows — new | 125 | 98 | **94** | **4** | **0.96** | 0.78 |

Clean subset (the 14 possible accept-clicks removed, 137 labels): old
97 emitted / 91 correct / 6 wrong, precision 0.94, recall 0.66 → new
107 emitted / 102 correct / 5 wrong, precision 0.95, recall 0.74. Restricted to
API-entry rows the clean subset is 18 labels: old emitted 1 and got it **wrong**
(precision 0.00); new emitted 11, 10 right.

**How much changes:** 124 suggestions where there were 108. **Not one existing
suggestion flips to a different name** — 102 stay identical, 22 are new, 6 are
withdrawn. Of the truth labels, 14 are newly named correctly and 2 correct ones
are lost. 10 of the 46 meetings see any change at all; 9 of those 10 are
API-entry rows.

Wrong-confident suggestions, by row: old was wrong on 376 (API-entry), 469, 478,
702, 790, 835; new is wrong on 469, 478, 702, 835, 861 (API-entry). Four are
shared, the Doc-derived row 790 is fixed, and the single API-entry mistake moves
from row 376 to row 861.

### 3.1 Why weighting and not the eval's hard dense-only cut

The shared-mic eval's rule — keep only windows with span ≥ 3 s AND ≥ 12 chars/s,
drop the rest — was measured here too. It fixes the API-entry rows just as well
but it costs 12 good Doc-derived suggestions, because on that source only 33% of
windows are "dense" by that definition and the sparse ones are still correctly
attributed (cross-name overlap is 0.04 there — nothing to be polluted by).

| variant | ALL prec / cov | API-entry prec / cov | Doc prec / cov | suggestions vs old (same / changed / added / removed) |
|---|---|---|---|---|
| old, flat | 0.94 / 0.67 | 0.67 / 0.12 | 0.95 / 0.78 | — |
| hard cut d ≥ 12, span ≥ 3 s | 0.94 / 0.68 | 0.86 / 0.54 | 0.95 / **0.70** | 91 / 0 / 19 / **17** |
| hard cut d ≥ 8 | 0.95 / 0.72 | 0.93 / 0.54 | 0.96 / 0.76 | 99 / 0 / 22 / 9 |
| threshold ladder 12→9→6→3, ≥ 4 windows & ≥ 60 s per name | 0.94 / 0.68 | 0.86 / 0.54 | 0.96 / 0.71 | 92 / 0 / 22 / 16 |
| **min(1, d/15), floor 2 c/s** | **0.96 / 0.74** | **0.93 / 0.54** | **0.96 / 0.78** | 102 / 0 / 22 / 6 |

A soft weight *is* the fallback the hard cut needs: a meeting with no dense
windows is not silenced, its windows simply count for less, and a producer whose
windows are all genuinely full (Teams VTT, a well-filled Doc block) is weighted
at 1 and behaves exactly as before. The explicit threshold ladder was built and
measured; it lands between the hard cut and the weight and is strictly worse
than the weight, so it is not shipped.

### 3.2 The constants are on a plateau

Sweeping the reference rate and the noise floor (`tmp/meet-align-eval/sweep.py`),
everything in ref 12–15 × floor 1–4 gives the identical result (ALL precision
0.96, coverage 0.74, 107 correct / 5 wrong); ref 18 or floor 6 loses one. The
decisive gate was swept too — now that it counts density-weighted ms, 20 s means
something stricter — and 0.60 / 20 s sits on the plateau (0.55/15 s would add one
correct suggestion, which is noise), so **the gate is unchanged**.

15 chars/s is the eval's continuous-speech rate, and the Doc parser already
assumes 14 (`CHARS_PER_SECOND` in `gmeet.ts`). 2 chars/s is the eval's p25 density
on API entries — below it a window is a backchannel inside someone else's flush.

### 3.3 The shipped TypeScript reproduces these numbers

`tmp/meet-align-eval/verify.ts` runs the real `computeMeetAlignment` over the
exported rows (rebuilding each window's text as `'x'.repeat(len)`, identical for
a rule that only reads `text.length`) and returns 112 emitted / 107 correct /
5 wrong / 124 total — the Python scorer's figures exactly.

---

## 4. The pooled-room rule, and the voice-split signal

The pooled-room rule (one Meet name decisively winning ≥ 2 AAI speakers → drop
all of them) is doing real work and is also the biggest remaining source of lost
coverage:

| | labels dropped | meetings | of the dropped, would have been RIGHT | would have been WRONG |
|---|---|---|---|---|
| old | 30 | 11 | 7 | 12 |
| new | 48 | 16 | 9 | 14 |

It fires more under the new weight simply because more names now become
decisive at all. Net it still buys precision — it discards 14 wrong names to
lose 9 right ones — but a third of what it throws away was correct.

**Recommendation: yes, the pooled-room rule should consume the shared-mic
eval's voice-split check later — as a release valve, not as a new trigger.**
The rule currently infers "two voices behind one device" from the alignment
itself, which is the weakest possible evidence for it; the eval's check answers
the same question directly from audio at ECAPA `split < 0.45`, held-out
precision 0.89 / recall 0.80 per participant and ~1.2 s of VM CPU per
participant. The shape to build:

1. Keep the rule's trigger as it is (it is cheap and it runs everywhere).
2. When it fires *and* the row has local media *and* the Meet↔AAI alignment
   preconditions in that eval's §9.2 hold, run the split check on that one name.
3. `split ≥ 0.45` (one voice) → the rule was a false alarm; keep the winning
   name on the AAI label with the most weighted time and drop the rest.
   `split < 0.45` (two voices) → drop, as today.
4. No media, stale preconditions, or a "no opinion" result (< 4 dense windows or
   < 60 s) → drop, as today. Silence must never be read as "single voice".

On this corpus that valve is worth up to 9 recovered correct names against 14
wrong ones it must keep suppressing, so it only pays if the check is as precise
held-out as the eval measured — which is exactly why it should be gated on the
preconditions and not run blind. Not built here.

---

## 5. What changed in the code

* **`src/lib/meet-align-vote.ts` (new, pure, no `server-only`)** — `windowWeight`,
  `hasDensitySignal`, `computeMeetAlignment` moved here from `meet-align.ts` and
  taught the weight. `AlignmentVote` keeps its shape; `overlapMs` is now
  density-weighted ms (speech-equivalent time), which the type says.
* **`src/lib/__tests__/meet-align-vote.test.ts` (new)** — 15 cases: the weight's
  clamp, floor and zero-span behaviour, a turn-level sidecar voting unchanged,
  a caption-flush sidecar where both names tile the same 120 s and the one who
  filled the windows wins, a case where flat overlap would have picked the wrong
  name, and the textless-sidecar fallback.
* **`src/lib/server/meet-align.ts`** — re-exports the vote, keeps
  `suggestSpeakersFromMeet`, the 0.60 / 20 s gate and the pooled-room drop
  unchanged. The suggestion's `evidence` string no longer claims the number is a
  raw share of overlapping time, and no longer says "Google Meet" on rows whose
  sidecar came from Teams.
* **`src/lib/format.ts`** — `MeetTranscriptEntry`'s doc comment no longer calls
  the entries "precise per-utterance times"; it states what they measured as.
* **Fallback for a sidecar with no usable text** (times but no characters — no
  such row exists in prod today, every one of the 46 carries text): density
  carries no information, so the vote falls back to flat overlap rather than
  going silent. Unit-tested.

Nothing about the stored shape changed: `speaker_mappings.suggestions` still
holds `{name, confidence, source: 'context', evidence}` and the People card
renders it exactly as before.

---

## 6. Caveats

* **The ground truth is partly the old algorithm's own output.** 14 of 151
  confirmed labels may be accept-clicks on an old suggestion; the clean-subset
  numbers are the pessimistic read and they tell the same story.
* **26 truth labels on 12 rows is a small sample for the case that matters.** The
  API-entry result (old 3 emitted, new 14) is a large effect on a small set; the
  single wrong suggestion moving from one row to another is not meaningful.
* **Teams VTT is untested here** — no prod row currently reaches this code with a
  VTT sidecar. Real cues are dense, so the weight should be ≈ 1 on them, but that
  is reasoning, not a measurement.
* **This rests on an undocumented property of Google's API** — that entry text
  length relative to the caption window tracks how much of it the speaker filled.
  If Google changes caption chunking the weight silently drifts toward flat
  (denser windows) or toward silence (sparser ones). Re-run
  `tmp/meet-align-eval/diag.py`; the observables to watch are median span ≈ 26 s
  and median density ≈ 5–6 c/s on the API-entry source.
* **Rows whose sidecar is on a different timeline** (`combinedParts`,
  `videoParts`, re-cut uploads) are as broken as they were — the weight does not
  fix misalignment, and this change does not add the alignment precondition the
  shared-mic eval recommends.
* Coverage on the API-entry source is 0.54, not 0.9. Half of those confirmed
  labels still get no suggestion, most of them because the pooled-room rule ate
  them (§4).

---

## 7. Reproducing

```
tmp/meet-align-eval/
  extract.py   pull the 46 rows (cluster ints + char COUNTS; no names, no text)
  diag.py      window span / density / cross-name overlap, split by producer
  score.py     old vs every candidate weight, scored against confirmed names
  sweep.py     sensitivity of the two constants and of the decisive gate
  verify.ts    re-run the SHIPPED TypeScript over the same rows
  rows.json    the exported dataset (integers and milliseconds only)
```

On the VM, read-only:

```
cd /temphigh/tmp-workspace/meet-align-eval
set -a; . ~/apps/meeting-whisperer/.env.local; set +a
nice -n 15 python3 extract.py data
```

then, offline on the laptop:

```
python3 diag.py rows.json
python3 score.py rows.json            # add --only-entries / --only-doc
python3 sweep.py rows.json
bun run tmp/meet-align-eval/verify.ts
```
