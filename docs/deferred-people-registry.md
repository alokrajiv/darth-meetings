# DEFERRED: People registry rework (plagueis-shape) + person-linked speakers + merge

Status: **deferred by Alok 2026-08-20** ("all except the people part looks thought thru
enough — defer the people part"). Everything else from the same planning session
(unified generate dialog, always-on sources hardening, multi-recording meetings)
was built. This doc is the pickup point — design agreed in principle, NOT reviewed
in detail; re-read the "current state" section against the code before building,
it will have drifted.

## Why

- Speaker labels are pure free-text (`SpeakerLabel = {originalSpeaker, customName,
  description}`); the speakers PUT **strips** any other field. Even where a person
  picker exists (speaker-badge-editor, speaker-preview-dialog, "+ Person"), the
  picked person object is discarded — only the name string survives.
- Voiceprints are keyed by `name_key = lower(trim(customName))` — free text. Prod
  has ~11 duplicate voice identities ("Ivan" vs "Ivan Seow"); `sameIdentity()` in
  `src/lib/server/voiceprint.ts` is a heuristic patch over the missing person key.
- The MW `people` table is flat `(name, email UNIQUE)` — one email per human, so
  work+personal email = two rows. No merge, no aliases, no admin UI, POST-only API.
- `Person.id` is NOT unique across sources ('trames' directory vs 'custom') —
  `(source, id)` or email is the only safe key today.
- The speaker-review dialog (the highest-traffic naming surface) uses plain
  `<Input>` fields — no directory search, no add-person, no attendee seeding.

## The model to copy: darth_plagueis (verified live 2026-08-20)

`darth_plagueis.ppl` is the canonical person table everything FKs to:

```
ppl (id serial PK, name NOT NULL, slack_handle, slack_id UNIQUE, primary_email,
     manager_id → ppl.id, team, role, is_bot bool NOT NULL default false,
     sso_user_id uuid, avatar_url, kind text NOT NULL default 'internal',
     company_id → companies.id, created_at)
emails (id PK, ppl_id → ppl.id NOT NULL, email UNIQUE)      -- alias table
companies (id PK, name, type default 'customer', description, website)
freshdesk_ppl_map (freshdesk id ↔ ppl_id, ON DELETE CASCADE) -- external-system identity mapping pattern
```

Key ideas: one person row regardless of internal/external (kind + company_id);
multiple emails via a thin alias table with a GLOBAL unique on email; external
systems map in via join tables, never by name matching. Prod stats at check time:
87 internal humans, 19 bots, 1 external; one person already has 2 emails.

## Agreed design

### 1. Schema (MW side)

```
people (id serial PK, name NOT NULL, kind 'internal'|'external' default 'external',
        is_bot bool default false, company text NULL,
        ppl_id int NULL,            -- link to darth_plagueis.ppl.id (cross-DB, no FK)
        merged_into int NULL REFERENCES people(id),   -- tombstone
        created_at, created_by, updated_at)
people_emails (id PK, person_id → people.id NOT NULL, email text UNIQUE NOT NULL)
```

- Migrate existing `people(name,email)` rows: each becomes a person + one
  people_emails row. Keep the old columns readable during transition or do it in
  one migration + code swap.
- **One id space via lazy materialization**: a Trames directory person gets a thin
  MW `people` row (with `ppl_id`) created on first reference (picker selection,
  import auto-registration). Display data (name/team/role/avatar) always read
  fresh from plagueis by `ppl_id` at query time — the MW row is just the stable
  local id + email cache. This kills the `(source, id)` ambiguity: everything
  downstream stores ONE `person_id` (MW people.id).
- Resolution rule everywhere: email → people_emails → person (follow
  `merged_into` chain at read, one hop is enough if merge always re-points).

### 2. Speaker labels carry personId

- `SpeakerLabel` gains optional `personId?: number` (display `customName` stays,
  used as fallback + for free-text-only labels).
- `validateLabels` in `/api/transcripts/[id]/speakers/route.ts` must WHITELIST
  `personId` instead of stripping it.
- `SpeakerSuggestion` gains `personId?` too, so AI/voiceprint suggestions can
  point at a person and the UI confirm keeps the link.
- No backfill of historical labels required at first — resolution layer
  (name/email → person) can lazily backfill when a transcript is opened/edited.

### 3. Voiceprints re-keyed to person

- `voiceprints` gains `person_id` (nullable during migration), enrollment keys on
  it when the label has one; `name_key` kept only for unlinked free-text labels.
- Migration folds today's name-keyed prints onto people via email/name resolution;
  merge the ~11 known dupe pairs (`scripts/find-voiceprint-dupes.ts` finds them,
  `scripts/merge-voiceprints.ts` has the weighted-average merge — promote that
  logic to `db-ops/voiceprints.mergeVoiceprints()`).
- `sameIdentity()` heuristic in voiceprint.ts becomes unnecessary for linked
  prints — delete once coverage is good.

### 4. Central person picker (the UX ask)

- A compact, **controlled** person-picker component (the current `UserPicker` is
  uncontrolled `initialValue` + autoFocus-true + outside-click-close — N stacked
  instances in a dialog fight; needs a `value`-controlled compact variant).
- Ranking: linked calendar event's attendees FIRST (the review dialog already
  knows them via gmeet_context.attendees), then registry/directory search, then
  "Add person" inline (name+email; email already known anywhere → that person,
  mirror the existing 409 flow in POST /api/people).
- Used in: speaker-review-dialog rows (replacing plain Inputs), speaker-badge-
  editor, speaker-preview-dialog — one component everywhere.
- Free text stays allowed → saves name-only label, NO phantom person row.
- Fix while in there: `UserPicker` uses `key={p.id}` — id collisions across
  sources; key must be `${source}:${id}` until the one-id-space lands.

### 5. Merge + /people page

- Merge B→A (plagueis-mechanical): move B's alias emails to A; repoint
  `voiceprints.person_id` (weighted-average if both have prints); stamp
  `merged_into=A` on B (tombstone, never delete); optionally repoint
  speaker_labels.personId lazily at read. Copy the `POST /api/series/:id/merge`
  route + `mergeSeries` txn pattern (logs who merged).
- Cross-source dupe (custom row duplicating a directory person): merge = set
  `ppl_id` on the survivor, tombstone the other.
- `/people` page: list (directory + custom, external/bot chips, email aliases),
  search, dupe candidates flagged (same normalized name / close voiceprint
  cosine — detection logic exists in scripts/find-voiceprint-dupes.ts), merge
  button, add person, edit name/kind/company.
- API: GET (list/search) + PATCH (edit) + POST merge on /api/people.

## Build order within this workstream

1. Migration (people + people_emails + voiceprints.person_id) + db-ops rewrite
   (searchPeople/findPersonByEmail return the new shape w/ lazy plagueis
   materialization).
2. Speakers API whitelists personId; enrollment uses it.
3. Person picker component + swap into the three speaker surfaces.
4. /people page + merge.
5. Voiceprint dupe cleanup migration run.

## Landmines (from the 2026-08-20 exploration)

- `transcript_shares.shared_with_ppl_id` stores a *plagueis* id — different id
  space from MW people.id; don't conflate when unifying.
- plagueis rows can have `email: null` (bots) — picker must tolerate email-less
  people; MW people_emails then has no row (identity = ppl_id link only).
- Import auto-registration (`import-helpers.ts` registerAttendees) creates people
  from attendee emails with humanized local-part names — this is the main source
  of junk/dupe custom rows; route it through the new email-resolution first.
- The speaker-review dialog's `onConfirm(names: Record<string,string>)` contract
  is string-only — widen to carry personId per speaker.
- AddPersonDialog is rendered by the transcript page keyed on a single
  `pendingCreate` — nesting inside the review dialog means dialog-in-dialog or
  lifted state.
