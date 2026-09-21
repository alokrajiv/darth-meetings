# Can we detect a shared mic cheaply? — eval for DEC-5

Status: **offline, read-only evaluation. Nothing was built or changed.**
Written 2026-09-21 (SGT). All prod queries ran read-only against
`meeting_whisperer_prod` between **2026-09-21 22:47 and 23:02 SGT**; the embedding
pass ran on the app VM (`azureuser@172.17.0.6`, 4 vCPU) at **2026-09-21 22:56–23:01 SGT**
under `nice -n 15`, in its own Python process with its own copy of the ECAPA model —
the production voiceprint sidecar on :3004 was never called.

Scripts: `tmp/shared-mic-eval/` in this repo; the same files ran from
`/temphigh/tmp-workspace/shared-mic-eval/` on the VM, whose stdout is kept in
`tmp/shared-mic-eval/vm-output/`.

No transcript text was read out of the database or into this document, no video
frame was decoded (every ffmpeg call is `-vn`), and people are referred to by
`row <transcript id> / sp#<index>` only.

---

## 0. The question, and the short answer

Google Meet hands us a free transcript with every line attributed to a named
participant — really to a participant's **device**. Several people on one room mic
all land under one name. Today we run AssemblyAI (paid, diarized) on nearly
everything to avoid that. DEC-5 asks whether we can detect "more than one voice is
speaking under a single Meet name" cheaply on our side, and only pay AssemblyAI
when the check fires.

**We can.** Cutting 8 × 5-second snippets of a Meet name's own speech, embedding them
with the ECAPA voiceprint model we already run, and asking whether they split into
two clusters separates shared mics from single speakers with **AUC 0.98** and, on
leave-one-meeting-out thresholds, **precision 0.89 / recall 0.80 per participant**
(0.94 / 0.89 per meeting). It costs **~1.2 s of VM CPU per participant, ~2–3 s per
meeting**.

The catch is not accuracy, it is **reach**: in the last 90 days only **65 of 336
AssemblyAI jobs (48.8 h of 241.6 h, 20%)** were meetings that had a free named
transcript at all. See §8.

---

## 1. Data

Prod holds 690 transcript rows. The eval needs all three of: local media, a real
AssemblyAI payload with acoustic `A`/`B`/`C` labels, and Google's own **named**
transcript entries.

| Filter | Rows |
|---|---|
| all transcript rows | 690 |
| … with local media (`local_audio_path`) | 510 |
| … with AAI utterances in `imported_content` | 639 |
| … with `gmeet_context.actuals.transcriptEntries` (Meet API, named) | 115 |
| … with `gmeet_context.meetTranscript.utterances` (Doc-derived, named) | 192 |
| **media + AAI utterances + Meet API entries** | **77** |
| … of those, a *real* AAI job (uuid id, not a synthetic `gmeet-…` row) with ≥3 utterances on both sides | **50** ← the dataset |

The 27 dropped rows are `gmeet-…` ids: those are Meet-transcript-only imports whose
`imported_content.utterances` already carry Meet's real names, so they have no
independent diarization to check against. The Doc-derived `meetTranscript` sidecar
was not used — it interpolates times inside 5-minute blocks by character weight
(`gmeet.ts` `parseMeetTranscriptDoc`), which is far too coarse.

**Dataset: 50 meetings, 41.2 h of audio, recorded 2026-07-21 → 2026-09-21 SGT,
median meeting 51 min.** One row (`914`) was dropped because its Meet sidecar does
not sit on the AAI timeline at all (only 39% of Meet speech lands on any AAI
utterance; it is a `videoParts` row). **49 rows survive; 46 contribute at least one
checkable participant.**

---

## 2. The thing that nearly killed the eval: Meet's entry times are not turns

`MeetTranscriptEntry` is documented in `src/lib/format.ts:115` as "precise
per-utterance times". It is not. Measured over all 10,498 entries in the dataset
(`tmp/shared-mic-eval/diag2.py`, output in `vm-output/`):

* median entry span **26.2 s**, p90 **29.4 s** — these are ~30-second caption-flush
  windows, not turns;
* a participant's entries are **exactly contiguous** (entry *n*'s `end` == entry
  *n+1*'s `start`), so once someone's caption stream opens it tiles their whole
  session;
* consequently the union of one name's windows covers **70–95% of the meeting**, and
  windows belonging to *different* names overlap each other **80–95%** of the time
  (median cross-name overlap 88.1% across the 50 rows).

Example: row `534` is a two-person call. Meet claims name 0 spoke for 4,255 s and
name 1 for 4,391 s of a 4,849 s meeting. Both are "true" only in the sense that each
said *something* inside almost every 30-second window — Meet transcribes
backchannels.

Overlapping those windows with AAI utterances naively labels **88% of all
(meeting, name) pairs as shared mics**. That is the wrong answer, and it is the trap
anyone re-doing this work will fall into. `meet-align.ts` is exposed to the same
problem: its pooled-room rule votes over exactly these windows.

### 2.1 What rescues it: caption density

Each entry carries text. Continuous speech runs at roughly 15 characters/second;
the **median entry only carries 5.9 chars/s** (p25 2.0, p90 14.4), i.e. the
attributed speaker filled about 40% of their own window. So:

> **dense entry** := span ≥ 3 s **and** `len(text) / span ≥ 12 chars/s`
> → a window this participant occupied almost completely.

Only the character *count* is used; no text leaves the database.

Restricted to dense entries the Meet-name → AAI-label mapping becomes sharp:
**median top-label share 0.94** (p25 0.82, p75 0.98) across 124 names
(`diag4.py`). Those same dense windows are also exactly the audio a cheap check
would cut snippets from, so ground truth and predictor look at the same material.

---

## 3. Ground truth

For each (meeting, Meet name): merge that name's dense windows, sum AAI speech
time per diarized label inside them, rank.

> **shared == the runner-up label holds ≥ 15% of the name's voted time AND ≥ 30 s.**

15% / 30 s is chosen to be well above AAI's boundary noise (a single speaker's
runner-up label sits at 0–7% in this data, see §6) while still catching a quiet
second person in a room; 30 s absolute keeps a 5-minute cameo from being decided by
three stray seconds. A name is **evaluable** when it has ≥ 4 dense windows and ≥ 60 s
of dense speech — below that there is nothing to sample and nothing to decide.

| | count |
|---|---|
| Meet display names across the 49 usable rows | 170 |
| … with ≥1 dense window | 123 |
| … **evaluable** (≥4 windows, ≥60 s) | **77**, in **46** meetings |
| dense speech per evaluable name | median 368 s (p10 114 s, p90 1228 s) |
| evaluable names per meeting | mean 1.67, median 1, max 4 |
| **shared mics (base rate)** | **20 / 77 = 26.0%** |
| meetings with ≥1 shared mic | **19 / 46 = 41%** |

### 3.1 Sensitivity of the definition

| runner-up share ≥ | and ≥ | shared | rate |
|---|---|---|---|
| 10% | 15 s | 24 | 31.2% |
| 10% | 30 s | 21 | 27.3% |
| **15%** | **30 s** | **20** | **26.0%** |
| 15% | 60 s | 19 | 24.7% |
| 20% | 30 s | 18 | 23.4% |
| 30% | 30 s | 12 | 15.6% |

The base rate is flat at 23–31% for any reasonable choice; only the aggressive
30% cut moves it. Nothing below depends on the exact knob.

### 3.2 Is the second label a second *voice*, or AAI over-splitting one person?

AAI is the reference, so AAI over-splitting a single speaker would manufacture fake
shared mics. Tested directly: group each name's snippets by the AAI label that owns
their window and take the cosine between the two group centroids.

For **18 of the 19** shared pairs where both groups had ≥2 snippets, the two groups
are genuinely different voices — centroid cosine **0.09 – 0.49** (median ≈ 0.30).
The two exceptions are row `512` sp#1 (0.63) and row `907` sp#0 (0.64), which are
plausibly AAI splitting one person; those are also two of the four misses in §5, so
true recall is probably better than the numbers below. One pair the ground truth
calls *single*, row `709` sp#0, scores 0.48 and may be a ground-truth miss.

### 3.3 The trivial predictor

"Does the Meet display name read as a room/device?" (room words, digits, >3 words):

**TP 7, FP 1, FN 13, TN 56 → precision 0.88, recall 0.35.**

It is precise and nearly free, but it finds only a third of shared mics — most rooms
in this data are logged in under a person's own account.

---

## 4. The check

For each evaluable name: pick up to **K** dense windows **spread across the meeting**
(bin the timeline into K slices, take the longest window in each — a room where one
person holds the first half and another the second is only caught if the snippets are
spread out), cut an **L-second** snippet from the middle of each with
`ffmpeg -vn -ac 1 -ar 16000`, embed with SpeechBrain ECAPA-TDNN (the sidecar's model,
`spkrec-ecapa-voxceleb`, 192-d, L2-normalised), then score:

| statistic | definition |
|---|---|
| `min` | lowest pairwise cosine among the K snippets |
| `p10` | 10th percentile of the pairwise cosines |
| `mean` | mean pairwise cosine |
| `split` | best 2-way partition with ≥2 snippets per side; the cosine between the two cluster centroids |

Low = the snippets disagree = more than one voice. `split` is the "two voices" shape
and is the one to use: `min` is a single outlier snippet away from firing.

> Note on thresholds: the 0.87-ish cosine from earlier voiceprint work is a
> *same-recording, same-enrolment* number. Within one meeting's real room audio the
> same speaker's snippets sit at **median 0.41 min-pairwise / 0.70 split** — nowhere
> near 0.87. Do not carry the old threshold over.

---

## 5. Results

77 evaluable pairs, 20 shared. Threshold tuned on the whole set (optimistic) and
then re-measured **leave-one-meeting-out** (LOMO: threshold fitted on the other 45
meetings, applied to the held-out one) — that second number is the honest one.

### 5.1 Best operating point per configuration (tuned in-sample)

| L | K | stat | thr | TP | FP | FN | TN | prec | rec | F1 | AUC |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 3 s | 8 | split | 0.276 | 16 | 1 | 4 | 56 | 0.94 | 0.80 | 0.86 | 0.95 |
| 3 s | 8 | mean | 0.328 | 17 | 3 | 3 | 54 | 0.85 | 0.85 | 0.85 | 0.93 |
| **5 s** | **8** | **split** | **0.433** | **16** | **0** | **4** | **57** | **1.00** | **0.80** | **0.89** | **0.98** |
| 5 s | 8 | min | 0.072 | 16 | 1 | 4 | 56 | 0.94 | 0.80 | 0.86 | 0.93 |
| 5 s | 10 | split | 0.472 | 18 | 4 | 2 | 53 | 0.82 | 0.90 | 0.86 | 0.97 |
| 8 s | 8 | split | 0.465 | 18 | 3 | 2 | 54 | 0.86 | 0.90 | 0.88 | 0.97 |
| 5 s | 3 | split | 0.266 | 14 | 5 | 6 | 52 | 0.74 | 0.70 | 0.72 | 0.82 |

### 5.2 Held-out (leave-one-meeting-out)

| L | K | stat | TP | FP | FN | TN | precision | recall | F1 |
|---|---|---|---|---|---|---|---|---|---|
| 3 s | 8 | mean | 16 | 3 | 4 | 54 | 0.84 | 0.80 | 0.82 |
| 3 s | 8 | split | 15 | 3 | 5 | 54 | 0.83 | 0.75 | 0.79 |
| **5 s** | **8** | **split** | **16** | **2** | **4** | **55** | **0.89** | **0.80** | **0.84** |
| 5 s | 8 | min | 15 | 1 | 5 | 56 | 0.94 | 0.75 | 0.83 |
| 5 s | 10 | split | 17 | 4 | 3 | 53 | 0.81 | 0.85 | 0.83 |
| 8 s | 8 | split | 17 | 3 | 3 | 54 | 0.85 | 0.85 | 0.85 |
| 8 s | 10 | min | 16 | 1 | 4 | 56 | 0.94 | 0.80 | 0.86 |
| 5 s | 5 | split | 14 | 6 | 6 | 51 | 0.70 | 0.70 | 0.70 |

The in-sample "precision 1.00" is threshold luck; held out, the honest figure is
**0.89 / 0.80**. Nothing in the 5–8 s × 8–10 snippet corner is meaningfully better
than anything else there, which is the good kind of result.

### 5.3 Threshold sweep (L=5 s, K=8, `split`)

| thr | TP | FP | FN | TN | prec | rec | F1 | FPR |
|---|---|---|---|---|---|---|---|---|
| 0.30 | 12 | 0 | 8 | 57 | 1.00 | 0.60 | 0.75 | 0.00 |
| 0.35 | 15 | 0 | 5 | 57 | 1.00 | 0.75 | 0.86 | 0.00 |
| 0.40 | 15 | 0 | 5 | 57 | 1.00 | 0.75 | 0.86 | 0.00 |
| **0.45** | **17** | **2** | **3** | **55** | **0.89** | **0.85** | **0.87** | **0.04** |
| 0.50 | 18 | 5 | 2 | 52 | 0.78 | 0.90 | 0.84 | 0.09 |
| 0.55 | 18 | 6 | 2 | 51 | 0.75 | 0.90 | 0.82 | 0.11 |
| 0.65 | 20 | 12 | 0 | 45 | 0.62 | 1.00 | 0.77 | 0.21 |
| 0.70 | 20 | 27 | 0 | 30 | 0.43 | 1.00 | 0.60 | 0.47 |

Recall 1.00 is reachable (thr 0.65) at precision 0.62 — i.e. you can be *certain*
never to skip AAI on a shared mic, at the price of paying for AAI on 12 extra
single-speaker participants out of 57.

### 5.4 Score distributions (L=5 s, K=8)

| class | stat | p10 | median | p90 | min | max |
|---|---|---|---|---|---|---|
| shared (n=20) | split | 0.13 | **0.25** | 0.63 | 0.08 | 0.64 |
| single (n=57) | split | 0.54 | **0.70** | 0.80 | 0.43 | 0.85 |
| shared | min | −0.05 | 0.01 | 0.28 | −0.07 | 0.45 |
| single | min | 0.18 | 0.41 | 0.54 | −0.15 | 0.65 |

The two `split` distributions barely touch — the overlap is 0.43–0.64, and that band
holds 4 shared and 4 single pairs out of 77.

### 5.5 Meeting level ("do we need AAI for this meeting at all?")

A meeting is flagged if any of its checkable participants fires. 46 meetings, 19 with
a shared mic:

| rule | TP | FP | FN | TN | precision | recall |
|---|---|---|---|---|---|---|
| `split < 0.40` | 15 | 0 | 4 | 27 | 1.00 | 0.79 |
| **`split < 0.45`** | **17** | **1** | **2** | **26** | **0.94** | **0.89** |
| `split < 0.70` | 19 | 18 | 0 | 9 | 0.51 | 1.00 |
| `min < 0.25` | 17 | 7 | 2 | 20 | 0.71 | 0.89 |

### 5.6 Adding the room-name heuristic

`voice OR room` is identical to `voice` alone at every operating point: all 7 room-name
true positives were already caught by the audio. The name heuristic adds nothing when
audio is available — it only matters where there is no recording (§7).

---

## 6. Failure cases

At the recommended meeting-level operating point (L=5 s, K=8, `split < 0.45`),
anonymised as `row / sp#`:

| case | row | sp# | split | min | truth: 2nd label | dense audio | room name? |
|---|---|---|---|---|---|---|---|
| **FP** | 195 | 4 | 0.44 | 0.22 | 4% / 4 s | 119 s | no |
| **FP** | 515 | 1 | 0.43 | −0.15 | 1% / 3 s | 449 s | no |
| **FN** | 465 | 0 | 0.45 | −0.05 | 21% / 84 s | 429 s | no |
| **FN** | 512 | 1 | 0.63 | 0.20 | 28% / 81 s | 306 s | no |
| **FN** | 907 | 0 | 0.64 | 0.28 | 33% / 149 s | 453 s | no |
| FN (at 0.433 only) | 296 | 1 | 0.45 | 0.45 | 37% / 38 s | 114 s | no |

Reading them:

* **Both false positives are single speakers whose snippets disagree with
  themselves.** Row `515` sp#1 has a *negative* minimum pairwise cosine over 449 s of
  dense speech — one snippet is acoustically nothing like the rest. The likely causes
  are the ones you would expect from real meeting audio: a stretch on speakerphone or
  a degraded connection, background noise dominating a snippet, or laughter/overtalk
  inside a "dense" window. `split` (which needs ≥2 snippets on each side) already
  suppresses most of this — `min` fires on both of these much harder.
* **Two of the three false negatives (`512` sp#1, `907` sp#0) are exactly the two
  pairs §3.2 flags as possible ground-truth errors**: the two AAI labels under those
  names have centroid cosine 0.63 / 0.64, i.e. the "second voice" may be AAI
  over-splitting one person. If so, real recall at this operating point is 17/17 and
  0.89 is pessimistic.
* **Row `465` sp#0 is a real miss**: 84 s of a second voice (21% of the name), and the
  snippets still cluster as one. Its `min` is −0.05, so `min` catches it and `split`
  does not — a second voice that speaks in short bursts can end up with only one
  snippet, and `split` requires two per cluster. A belt-and-braces rule
  (`split < 0.45 OR min < 0.05`) would catch it; it also picks up both false
  positives, so it trades precision 0.89 → 0.77 for recall 0.85 → 0.90.
* **Row `296` is a `combinedParts` row** (two recordings concatenated with gaps
  removed). Its Meet sidecar is remapped at import, but its alignment is the second
  worst in the set (0.73). Concatenated rows deserve suspicion in production.
* One row, `914`, had to be **excluded entirely** — its Meet sidecar and its audio are
  on different timelines (39% alignment). In production that is not a failure of the
  check, it is a precondition the pipeline must verify before trusting any of this.

---

## 7. Runtime cost

Measured on the app VM (4 vCPU, `nice -n 15`, 3 torch threads, model resident):

| | |
|---|---|
| full eval pass | 77 participants × 3 snippet lengths × ≤10 snippets = **1,849 embeddings in 278 s wall** |
| per snippet (ffmpeg seek + slice + ECAPA) | **0.150 s** |
| per participant at L=5 s, K=8 | **1.2 s** |
| per meeting (mean 1.67 checkable participants) | **2.0 s** |
| per meeting if every name with ≥1 dense window is checked (2.67) | **3.2 s** |
| model load, one-off | ~5 s (already amortised — the sidecar is resident) |

For scale: the eval covered 41.2 h of audio; the CPU cost of checking all of it at the
production configuration is **under 2 minutes**. This is free compared to an AAI job.
`ffmpeg` fast-seeks (`-ss` before `-i`, `-vn`) so file size does not matter much.

---

## 8. What this cannot cover

**The reach problem, which is bigger than the accuracy problem.** Of the AAI jobs
created in the last 90 days:

| | jobs | hours |
|---|---|---|
| real AAI jobs, not deleted | 336 | 241.6 |
| … that had *any* free named transcript (Meet API entries or Doc/VTT) | **65** | **48.8** |

So even a perfect gate can only ever be offered on **20% of what we spend**, and
41% of those meetings have a shared mic and would still need AAI — leaving a realistic
ceiling of roughly **12% of AAI hours**. The case for building this is *speed and
quality* (an instant, named transcript for meetings that do not need diarization),
not cost.

Other hard limits:

* **Meet transcript with no recording → no check at all.** 118 live `gmeet` rows have a
  named Meet transcript and *no local audio*. There is nothing to embed; only the
  room-name heuristic applies, at recall 0.35.
* **Meet's named entries expire.** Only 114 of 579 live `gmeet` rows carry
  `actuals.transcriptEntries` — Google drops them 30 days after the meeting
  (`format.ts:117`), and the Doc route gives only 5-minute-block interpolation. The
  density trick needs the API entries.
* **Teams is not evaluated.** Zero Teams rows carry Meet-API-style entries; 26 live
  Teams rows carry VTT-derived cues (22 with audio). VTT cues *are* turn-level, so the
  timing may well be better than Meet's — but the caption-density rule is Meet-specific
  and untested there. Treat Teams as unknown until someone repeats this on it.
* **Quiet participants get no verdict.** 46 of 123 names with ≥1 dense window did not
  reach 4 windows / 60 s. A person who says little in a shared room is precisely who
  the check will stay silent about; a "no opinion" result must not be read as "single".
* **It says nothing about *who*.** A fired check means "do not trust this name",
  not "here are the two people". Splitting the room still requires diarization.
* **It depends on an undocumented property of Google's API** — that entry text length
  relative to the caption window tracks how much of that window the speaker filled.
  If Google changes caption chunking, the dense-window filter silently degrades. A
  production implementation should assert on the observable (median entry span ≈ 26 s,
  median density ≈ 6 chars/s) and fall back to "always AAI" when it does not hold.
* **Gating on Meet means waiting for Google.** Meet's transcript entries appear minutes
  to hours after the meeting; AAI can start the moment the recording lands. A gate
  trades latency for spend unless the import already waits for artifacts.
* **Rows whose sidecar is on another timeline** (`combinedParts`, `videoParts`,
  re-cut uploads) must be excluded — 1 of 50 here, and the worst-aligned survivor was
  also a failure case. Check Meet↔AAI alignment before trusting the check.

---

## 9. Recommendation

**Reliable enough to gate AssemblyAI — at the meeting level, with a conservative
threshold, and only where a Meet recording plus fresh Meet API entries both exist.**
Use L = 5 s, K = 8 snippets spread across the meeting, statistic `split`, fire when
`split < 0.45`: held out that is precision 0.94 / recall 0.89 over 46 meetings at
~2 s of VM CPU per meeting, and the two misses it makes are pairs where the ground
truth itself is doubtful. Because the remaining risk is a silently mis-attributed
room transcript, pair it with the existing one-click re-transcribe rather than
treating the decision as final — and note that the whole mechanism can only ever
touch ~20% of our AAI hours, so build it for the instant named transcript, not for
the invoice.

Concretely, if this is built:

1. Gate per **meeting**, not per participant. A single fired participant means the
   whole meeting goes to AAI.
2. Precondition checks first: Meet API entries present, Meet↔AAI-style alignment
   sane, entry span/density distribution as expected, row not a concat. Any failure →
   AAI, no question.
3. Threshold `split < 0.45`; consider `OR min < 0.05` if a miss is judged worse than
   paying for AAI on a few extra meetings (recall 0.85 → 0.90, precision 0.89 → 0.77
   at participant level).
4. Keep the room-name heuristic only for the audio-less case; it adds nothing when
   audio is available.
5. Show the verdict. "Meet's own transcript, checked: every name is one voice" is a
   claim the user should be able to see and override — and the existing "upload
   recording & re-transcribe" path is the override.
6. Re-run this eval whenever Google's caption behaviour looks different; the whole
   thing rests on §2.1.

---

## 10. Reproducing

```
tmp/shared-mic-eval/
  extract.py      pull the dataset (timings + per-entry char COUNT; no text)
  groundtruth.py  dense-window filter, ground truth, sensitivity, room-name baseline
  embed_eval.py   snippet selection + ECAPA embeddings (its own model copy, nice 15)
  analyse.py      statistics, confusion matrices, LOMO, failure cases, GT validation
  diag.py         per-row label-mass matrix (why the naive ground truth fails)
  diag2.py        entry span / contiguity / cross-name overlap (the §2 evidence)
  diag3.py        onset-only probe (also insufficient)
  diag4.py        dense-entry purity (the §2.1 evidence)
  vm-output/      run.log, analyse.out as produced on the VM
```

On the VM:

```
cd /temphigh/tmp-workspace/shared-mic-eval
set -a; . ~/apps/meeting-whisperer/.env.local; set +a   # read-only queries only
python3 extract.py data
python3 groundtruth.py data 12
nice -n 15 ~/.mw-voiceprint/venv/bin/python embed_eval.py data
nice -n 15 ~/.mw-voiceprint/venv/bin/python analyse.py data
```

`embed_eval.py` reads the model from a **copy** at
`/temphigh/tmp-workspace/shared-mic-eval/model` (taken from `~/.mw-voiceprint/model`)
so nothing touches the running sidecar, reads media read-only from
`~/apps/meeting-whisperer/storage/audio`, and writes only inside the scratch
directory.
