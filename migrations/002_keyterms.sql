-- AssemblyAI is retiring `word_boost` / `boost_param` in favour of the new
-- `keyterms_prompt` feature (Universal-3 Pro / Slam-1). keyterms_prompt is a
-- flat string array (no per-entry weights, no global boost level), so this
-- migration:
--   1. Renames `word_boost` → `keyterms_prompt` on user_vocab, org_vocab,
--      and org_vocab_history.
--   2. Stops referring to "boost" anywhere in the schema.
--
-- Data migration is a no-op — the tables are empty in prod at the time of
-- this migration. If non-empty data shows up later, the `{word, weight}[]`
-- shape would need flattening to `string[]`, which the app layer will
-- tolerate on read via a defensive parser. Custom spelling is unaffected.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE user_vocab         RENAME COLUMN word_boost TO keyterms_prompt;
ALTER TABLE org_vocab          RENAME COLUMN word_boost TO keyterms_prompt;
ALTER TABLE org_vocab_history  RENAME COLUMN word_boost TO keyterms_prompt;
