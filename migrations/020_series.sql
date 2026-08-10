-- Recurring-call series as a first-class object ("recurring call badge").
--
-- Identity lives HERE, not in provider keys: gcal recurringEventIds get
-- re-sliced on every "this and following" edit (…_R20260217T050000 variants),
-- meeting codes get recycled across unrelated meetings, and a Teams meeting
-- created from gcal has BOTH a gcal recurring id and a Graph meeting id.
-- A series therefore owns a bag of evidence keys (series_keys) that
-- accumulates as the user confirms suggestions; transcripts attach through
-- series_members. Occurrences themselves are never mirrored — the series
-- dialog computes them live from calendar + Graph.

CREATE TABLE IF NOT EXISTS series (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  created_by UUID NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Evidence: kind ∈ 'recurring-base-id' (gcal id before the _R… suffix),
-- 'ical-uid-base' (iCalUID stripped of @google.com), 'meeting-code' (weak —
-- codes get recycled), 'teams-join-url', 'graph-meeting-id',
-- 'normalized-title' (weak). One key value belongs to at most one series.
CREATE TABLE IF NOT EXISTS series_keys (
  id SERIAL PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  -- 'import' | 'user' | 'backfill' — where the evidence came from
  source TEXT NOT NULL DEFAULT 'user',
  added_by UUID,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS series_keys_series_idx ON series_keys(series_id);

-- Membership: a transcript belongs to at most one series.
-- how: 'auto' (strong key match at import), 'confirmed' (user said yes to a
-- guess), 'manual' (user attached it by hand).
CREATE TABLE IF NOT EXISTS series_members (
  id SERIAL PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  transcript_id INTEGER NOT NULL UNIQUE REFERENCES transcripts(id) ON DELETE CASCADE,
  how TEXT NOT NULL DEFAULT 'auto',
  added_by UUID,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS series_members_series_idx ON series_members(series_id);

-- Remembered "no, this isn't part of that series" answers, so a rejected
-- guess is never re-suggested and auto-attach never overrides the human.
CREATE TABLE IF NOT EXISTS series_exclusions (
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  excluded_by UUID,
  excluded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (series_id, transcript_id)
);
