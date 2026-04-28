-- Meeting-whisperer's own "people" table. Used when a user commits a custom
-- speaker name — we ask for an email, check the Trames directory
-- (darth_plagueis.ppl) for a match, and if none is found we add a row here.
-- This keeps meeting-whisperer's writes out of darth_plagueis while still
-- letting us treat added people as first-class objects (searchable from
-- the picker, shareable by email).
--
-- Email identity is case-insensitive. Uniqueness is enforced on LOWER(email)
-- so writers never have to pre-normalise (though the app normalises anyway).

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS people (
  id          serial      PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS people_email_lower_key ON people ((LOWER(email)));
CREATE INDEX IF NOT EXISTS people_name_idx ON people (LOWER(name));
