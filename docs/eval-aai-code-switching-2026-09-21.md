# Eval — English spoken, Indonesian written (AAI language lock)

**Date:** 2026-09-21 (SGT) · **Reporter:** Alok · **Row:** `591b102e-2831-4eb3-aece-8172edde0133`
(DB id 920, "Hypercare - PGLS Trames Go Live Support OKI - Perawang", 56m45s, owner atira.sarat@trames.sg)

> "Atira's recording was mixed English and Indonesian, but somehow the AssemblyAI model wrote all of
> it as Indonesian… Atira's first dialogue was all English, but what's written in the transcript is
> the Indonesian-translated version of what she said."

Confirmed, reproduced, root-caused. It is an AssemblyAI behaviour, not a bug in our submit — but our
submit has no defence against it and our UI misreports which model ran.

---

## 1. Facts

### What we sent (from `src/lib/server/assemblyai.ts` → `submitTranscription`)

```json
{
  "audio": "<aai upload url>",
  "speaker_labels": true,
  "speech_models": ["universal-3-5-pro"],
  "language_detection": true,
  "keyterms_prompt": ["Ivan Seow", "Ka Wen Koh", "Alok Rajiv", … 36 attendee names]
}
```

No `language_code` (the recorder/stitch path never sets one → "Auto Detect" branch), no
`custom_spelling` (org+user vocab has none), no `multichannel`, no
`language_confidence_threshold`, no `language_detection_options`.

### What AAI returned (`imported_content`)

| field | row 920 (the complaint) | sibling `28b33e8e…` (id 919) |
|---|---|---|
| `language_code` | **`id`** | `en` |
| `language_confidence` | **0.9273** | 0.4032 |
| `speech_models` (asked) | `["universal-3-5-pro"]` | `["universal-3-5-pro"]` |
| `speech_model_used` | **`universal-2`** | `universal-3-5-pro` |
| `confidence` (ASR) | **0.6165** | 0 (empty transcript) |
| `audio_duration` | 3405 s | 125 s |

`imported_content.metadata.warnings` on row 920 — AAI told us exactly what happened:

1. `` `keyterms_prompt` was not applied because it is only supported for … en, en_au, en_uk, en_us ``
2. `'id' is not supported in universal-3-5-pro — transcription is handled by universal-2. To silence
   this warning, set speech_models: ["universal-3-5-pro", "universal-2"].`

The sibling row is a 2-minute dead segment with an **empty transcript** — it is not a useful control.

### Atira's opening as stored (utterance 1, t=15.117 s, speaker A)

> Ok, jadi kita mulai dengan booking seperti biasa. Hari ini ada 8 booking yang dibuat, tidak terlalu
> banyak. Tapi kebanyakan adalah MSC. Jadi untuk MSC, saya akan mulai dengan booking hari ini dulu…

She spoke English. That text is a **translation**, not a mis-transcription (see §2 config a).

### Scale (prod, `language_code='id'`, not deleted)

5 rows / 5.2 h, all since 2026-09-10, all asked for 3.5 Pro, **all ran on universal-2**:
ids 724, 831, 844, 905, 920. Mean ASR `confidence` **0.61** vs **0.94** for the 341 English rows —
the low ASR confidence is a reliable automatic signal that this happened.

---

## 2. Slice experiments

Audio: `591b102e….mp4` on the VM, two 180 s mono 16 kHz mp3 slices cut with ffmpeg
(`0–180 s` = Atira's English opening; `240–420 s` = Indonesian-heavy with embedded English).
**No video frames were opened.** 9 AAI jobs, 3 min each.

### Slice 1 (0–180 s, Atira's English opening)

| # | request (abridged) | `language_code` | `language_confidence` | `speech_model_used` | ASR conf |
|---|---|---|---|---|---|
| a | **exact prod params** `speech_models:["universal-3-5-pro"]`, `language_detection:true`, `keyterms_prompt` | `en` | 0.2934 | universal-3-5-pro | 0.957 |
| b | `language_detection:true` only (AAI default model) | `en` | 0.2933 | universal-2 | 0.953 |
| c | `speech_models:["universal-2"]`, `language_detection:true`, `language_detection_options:{code_switching:true, code_switching_confidence_threshold:0.5}` | `en` | 0.6975 | universal-2 | 0.953 |
| d | `speech_models:["universal-3-5-pro"]`, `language_code:"en"` | `en_us` | — | universal-3-5-pro | 0.962 |
| e | **control:** `speech_models:["universal-3-5-pro"]`, `language_code:"id"` | `id` | — | universal-2 | 0.582 |
| j | `speech_models:["universal-2"]`, `language_codes:["en","id"]` (documented manual code-switch pair) | `id` | — | universal-2 | 0.582 |

**a** (5 lines):
> Okay. Okay, so let's start with bookings as usual. Today there were eight bookings that were made.
> Not too many, but most of it is MSC. So for MSC, so I'll start with today's bookings first, and
> we'll go to maybe like last Friday, last Thursday as well. … For ONEY, the current issue is that
> ONEY is not able to confirm our bookings because of the ship-to address. … So no, like, street
> name, postal code, all those details are still missing.

**b / c** (5 lines) — same English, but without keyterms the proper nouns degrade:
> Okay, so let's start with bookings as usual. Today there were eight bookings that were made. Not
> too many, but most of it is msc. … But so far, so good for **1ey**. The current issue is that
> **1ey** is not able to confirm our bookings because of the **shipto** address. … so no, like
> street name postal code. All those details are still missing.

**e / j** (5 lines) — **byte-identical ASR confidence 0.5822928; this is the production text**:
> Oke, jadi kita mulai dengan booking seperti biasa. Hari ini ada 8 booking yang dibuat. Tidak
> terlalu banyak, tapi kebanyakan adalah MSC. … Untuk ONEY, masalah saat ini adalah ONEY tidak dapat
> mengesahkan booking-nya kami karena dengan alamat shipped to. … Jadi, tidak seperti nama jalan,
> kode poster, semua detail itu masih hilang.

Line-for-line the same content as (a), in Indonesian. **Forcing `id` on English speech makes
universal-2 translate it.** That is the whole complaint, reproduced in 3 minutes of audio.

### Slice 2 (240–420 s, Indonesian-heavy)

| # | request (abridged) | `language_code` | `language_confidence` | `speech_model_used` | ASR conf |
|---|---|---|---|---|---|
| f | **exact prod params** | `id` | 0.9527 | universal-2 | 0.5500 |
| g | `speech_models:["universal-3-5-pro","universal-2"]` + `language_detection_options:{code_switching:true, …0.5}` | `id` | 0.9527 | universal-2 | 0.5500 |
| h | `speech_models:["universal-3-5-pro"]`, `language_code:"en"` | `en_us` | — | universal-3-5-pro | 0.758 |
| i | `speech_models:["universal-2"]`, `language_codes:["en","id"]` | `id` | — | universal-2 | 0.5500 |

**f = g = i, byte-identical output** (5 lines) — English *inside* an Indonesian turn does survive:
> A: Kalo hari kanan-kiri, / B: yang ini bener gak? Seat 2-nya namanya ini? / C: Ini dia di sini
> keliatan ga nih, BIC siapa itu? / A: Satria, sorry, / **C: you can show us the BIC one, who
> created this booking?**

**h** (forced English on Indonesian speech) — catastrophic: **2 utterances for 3 minutes of audio**,
the rest dropped entirely:
> [27s] A: Uh, you can be back again. / [44s] B: Uh, the address is D block, like that. Uh, So, and
> then please open the— yeah, so this is the book by Araria.

### What the AAI docs say (fetched 2026-09-21)

- Universal-3.5 Pro has **native code switching across 18 languages**: English (4 variants),
  Spanish, French, German, Italian, Portuguese, Arabic, Danish, Dutch, Finnish, Hebrew, Hindi,
  Japanese, Mandarin, Norwegian, Swedish, Turkish, Vietnamese. **Indonesian is not one of them.**
- When detection lands on a language outside those 18, AAI "automatically falls back to Universal-2".
- Universal-2's `language_detection_options.code_switching` / `language_codes:["en", X]` is
  documented as an English-pair feature; **our probes (c, g, i) show it is a no-op for `id`** —
  identical bytes and identical ASR confidence to plain forced `id`.
- `language_confidence_threshold` does not repair anything; it makes the job *fail* below a floor.
- `language_detection_options.expected_languages` / `fallback_language` still pick **one** language
  for the whole file.

---

## 3. Diagnosis

**(i), with an aggravating factor.** AssemblyAI's automatic language detection resolves **one
language for the entire file**. On this 57-minute recording the Indonesian majority won
(`id`, 0.9273). Indonesian is outside Universal-3.5 Pro's 18 code-switching languages, so AAI
silently downgraded the job to **Universal-2 forced to Indonesian**, and Universal-2 decoding a long
monolingual-English stretch under an Indonesian language model **emits a translation** rather than
the English words — exactly what control (e) reproduces on the same audio. Short English fragments
inside an Indonesian turn do survive; whole English turns do not.

Not (ii): our params are correct and the `keyterms_prompt` English gate behaved as designed — AAI
merely *ignored* the bias list (warning 1) instead of rejecting the submit, which is why the same
names come back as "1ey"/"shipto" in the id transcript. Not (iii): the stitched-segment path is
irrelevant — the 3-minute unstitched slice reproduces the failure the moment `id` is in play, and
detection is whole-file regardless of how the file was assembled. The 2026-09-09 decision
("keyterms English-only gate; Auto Detect real; 3.5 Pro splits English inside zh — accepted") is
intact; the new fact is that *Auto Detect on a majority-Indonesian call silently downgrades the
model and translates the minority language*.

Aggravating factor we own: the row stores `speech_model = 'universal-3-5-pro'` (what we asked for),
so the Sources card tells the reader "Transcribed with AssemblyAI Universal-3.5 Pro" — **false**, it
was Universal-2. We drop `speech_model_used` and `metadata.warnings` on the floor.

---

## 4. Recommendation

**No AssemblyAI parameter fixes en↔id today.** Forcing `id` translates the English (e, j); forcing
`en` deletes the Indonesian (h); every documented code-switching switch is a no-op for `id`
(c, g, i). So the fix is product-side, in this order:

1. **Stop lying about the model, and warn (small, ship first).**
   Persist `imported_content.speech_model_used` and `metadata.warnings` onto the row (or just read
   them in `transcript-sources-card.tsx`), label the card with the model that *actually ran*, and
   show a banner when `speech_model_used != speech_model` **or** `language_code` is outside
   `en*` **or** ASR `confidence < 0.8`: *"AssemblyAI detected Indonesian (93%) for the whole
   recording and ran Universal-2. English speech in this meeting may have been rendered in
   Indonesian."* The 0.61-vs-0.94 confidence gap makes this a reliable automatic trigger — all 5
   `id` rows fire, no English row does.
2. **Send `speech_models: ["universal-3-5-pro", "universal-2"]`** in `submitTranscription`
   (one line). Proven behaviour-neutral (f ≡ g) but it is AAI's documented form, silences the
   warning, and makes the fallback explicit rather than accidental.
3. **Give the user the language lever on the paths that lack it.** `?language_code=` already exists
   on `POST /api/transcripts`, but the Darth Recorder / stitch / auto-import paths never set it.
   Add a per-series and per-user default language (these hypercare calls are a recurring series),
   and a "re-transcribe in <language>" action. **Note two blockers in the current
   `POST /api/transcripts/:id/retranscribe`:** it 409s because the row already ran on
   `DEFAULT_SPEECH_MODEL`, and it passes `languageCode: row.language_code` — i.e. `'id'` — so as
   written it would *reproduce* the bug. Both need to change before a re-run is offered.
4. **The actual mixed-language fix (bigger):** windowed detection — split the audio into ~2–5 min
   windows, detect per window, submit each with its own `language_code`, stitch with a time offset
   (the `videoParts`/`meet-align` machinery already does offset remapping). Alternatively bench
   ElevenLabs Scribe v2 or Gemini on one of these 5 recordings; AAI's own benchmark page only claims
   code switching for its 18, and Indonesian is not on the roadmap we can see. Worth also asking
   AssemblyAI support directly whether `id` is coming to 3.5 Pro.

**Re-transcribing row 920 will not help and should not be run.** Its stored `language_code` is `id`,
and a forced-`id` run is byte-identical to what it already has (proven by control e). A forced-`en`
run would destroy the Indonesian 80% of the meeting (proven by h). If Alok wants the English turns
recovered, the only correct move today is a windowed re-run (item 4) or a manual re-run of the
English stretches only. For the record, the call that *would* be used once item 3 lands:

```
curl -X POST https://meetings.darth-internal.trames.io/api/transcripts/591b102e-2831-4eb3-aece-8172edde0133/retranscribe \
     -H 'content-type: application/json' -d '{"languageCode":"en"}'    # route does not accept this yet
```

---

## 5. Cost of this eval

9 AssemblyAI jobs × 180 s = 27 min of audio (0.45 h). 3 jobs on Universal-3.5 Pro (~$0.23/h incl.
diarization), 6 on Universal-2 (~$0.17/h). **≈ $0.09 total.** Two 1.4 MB slices; no full-file
re-transcription was run. Prod DB access was read-only (`employee_alok_ro`); nothing was written.

AAI job ids: slice 1 — a `c105125e…`, b `d86f399a…`, c `81b6ea95…`, d `9866b15f…`, e `f6574710…`,
j `2997e1a5…`; slice 2 — f `1b35cf06…`, g `a7c2097f…`, h `52906053…`, i `cbd47903…`.
