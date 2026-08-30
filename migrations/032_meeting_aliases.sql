-- T1 review fix: a handed-out /m/<uuid> must NEVER die. When two meetings
-- rows collapse into one (force re-import of an already-imported occurrence,
-- or two users' queued placeholders fulfilling for the same final id), the
-- losing row's uuid becomes an ALIAS of the survivor instead of 404ing.
-- getMeetingById falls through to this table on a miss.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS meeting_aliases (
  alias      uuid        PRIMARY KEY,
  meeting_id uuid        NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_aliases_meeting_idx ON meeting_aliases (meeting_id);
