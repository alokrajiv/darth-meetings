-- Duration-weighted voiceprints (2026-09-24, "rescore the fingerprints on
-- long rants"). Until now every enrolled sample counted once in a person's
-- running mean, whether it came from 5 s or 5 minutes of their speech. From
-- here on each sample weighs the seconds of audio behind it (capped at 180 s
-- per sample in code, lib/voiceprint-math.ts), and this column holds the
-- total weight behind the stored mean.
--
-- 0 = a row enrolled before this migration: enrolment falls back to
-- `sample_count` as its weight. scripts/rebuild-voiceprints.ts --apply
-- recomputes every row from the confirmed speaker labels and fills it.
--
-- Additive only. Name keys are NOT rewritten here even though the code now
-- keys by personNameKey ("karnica.katiyar" → "karnica katiyar"): the
-- UNIQUE(name_key) constraint would collide on the duplicates, and folding
-- them is the rebuild script's job (with a backup table first).
--
-- CONVENTION (docs/recordings-phase1-spec.md §5a): every migration here
-- hard-codes the PROD schema on the line below. Applying this to any other
-- schema means sed-ing that one line first, e.g.
--   sed 's/meeting_whisperer_prod/meeting_whisperer_stage/' 050_voiceprint_weight_secs.sql | psql …
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE voiceprints ADD COLUMN IF NOT EXISTS weight_secs double precision NOT NULL DEFAULT 0;
