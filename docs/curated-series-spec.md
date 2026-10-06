# Curated series — spec (2026-10-06)

Owner decisions (Alok, 2026-10-06, this session): the key-based series ("evidence bag",
`series_keys`) are thrown away. 378 of 383 memberships were automatic, 5 confirmed;
nobody curates them. Replace them with a small set of HAND-CURATED series that are
known to be accurate:

- each series has a **name**, a **description** (what it is), **patterns** (the
  "grepper": title regexes, optionally an invite rule) and **one or more default
  labels** — every meeting in the series carries those labels;
- **followers**: people who get a read share of every meeting in the series (past
  and future), like the auditor shares (`src/lib/auditor-policy.ts`);
- anyone can create/edit series; everyone sees every series;
- the 6 series with auto-import on are carried over (re-created as curated series
  with the same `auto_import` config).

Backups of the old data: `.6:~/backups/series-backup-2026-10-06.{dump,sql}`
(pg_dump -Fc + data-only inserts of series, series_keys, series_members,
series_exclusions, series_auto_import_log, label_rules, labels, transcript_labels).

The codebase map this spec builds on (file:line refs) is summarised in §9.

## 1. Data model — migration `053_curated_series.sql`

Additive only (the destructive reset is a separate one-off script, §8):

```sql
ALTER TABLE series ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS patterns jsonb NOT NULL DEFAULT '[]';
ALTER TABLE series ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 100;

CREATE TABLE IF NOT EXISTS series_followers (
  series_id        int  NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  email            text NOT NULL,           -- lower-cased
  name             text,
  added_by_user_id uuid NOT NULL,
  added_by_email   text NOT NULL,
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, email)
);

-- Default labels: one label_rules row (kind='series', value=series id) PER label.
DROP INDEX IF EXISTS label_rules_series_value_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS label_rules_series_label_uniq
  ON label_rules (value, label_id) WHERE kind = 'series' AND label_id IS NOT NULL;

-- The share-removal ledger (052) now records follow removals too.
ALTER TABLE auditor_share_removals ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'auditor-external';
```

`series_keys` stays in the schema but nothing reads or writes it any more.
`series_members` keeps `transcript_id UNIQUE`: a meeting is in at most one series.
`series_exclusions` keeps its meaning ("not this series", a human answer that beats
the patterns). `series_members.how`: `'auto'` (patterns matched), `'manual'` (a human
attached it; survives pattern changes). `'confirmed'` is no longer written.

## 2. Patterns — pure module `src/lib/series-patterns.ts`

```ts
export type SeriesPattern =
  | { kind: 'title'; regex: string }        // JS RegExp, flags 'i', on eventTitle ?? title
  | { kind: 'invite';
      all: string[];                         // every one of these emails is on the invite
      any?: string[];                        // at least one of these (optional)
      internalOnly?: boolean;                // no attendee outside AUTO_SHARE_DOMAINS
      recurringOnly?: boolean;               // recurring calendar event
      maxPeople?: number };

export interface SeriesFacts {
  title: string | null;          // gmeet_context.eventTitle ?? transcripts.title (calendar: title)
  emails: string[];              // attendees + organizer, lower-cased (resource calendars dropped)
  recurring: boolean;            // gmeet_context.recurringEventId / calendar recurring_event_id
}
```

- A series matches when ANY of its patterns matches. Empty patterns = matches nothing
  (manual members only).
- Several series match → the winner is the lowest `priority`, then the lowest id.
- `validatePatterns(input)` — rejects: non-array, unknown kind, regex that does not
  compile, regex longer than 300 chars, invite with empty `all`, invalid emails, more
  than 20 patterns. Used by every write route.
- Evaluate regexes in JS only (never Postgres `~*` — different dialect), so the same
  function serves stored meetings and calendar rows.
- Internal domains: import `AUTO_SHARE_DOMAINS` (lib/server/auto-share.ts) is
  server-only — move the set into a pure module (e.g. `src/lib/internal-domains.ts`)
  and re-export it from auto-share.ts so nothing else changes.
- `factsFromContext(row)` / `factsFromCalendarRow(row)` adapters live here too.

## 3. Membership

- `src/lib/server/curated-series.ts` (new) is THE membership engine:
  - `loadCuratedSeries()` — all series with patterns, priority, exclusions-aware; cached
    in-process ~60 s and busted on every series write.
  - `syncSeriesForTranscript(transcriptId)` — compute facts from the row; manual member
    → leave alone; otherwise winner = match minus series the transcript is excluded from;
    add/move/remove the `'auto'` membership; then apply labels (§4) and follower shares
    (§5) for the old and new series. Deleted/scratch rows: drop auto membership.
  - `rematchAll(seriesId?)` — every live, non-scratch transcript; run after a series'
    patterns/priority change, after create, and every 10 min as a backstop (catches
    retitles and links). Log `[curated-series] rematch: +N −M moved K`.
- Replace `autoAttachSeries` / `retroAttachSweep` (series-attach.ts) callers (ingest.ts,
  ingest-parsed.ts, clip-split.ts, merge route) with `syncSeriesForTranscript`. Also call
  it from link-event (an event link changes the facts). Delete `series_keys` writers.
- The "suspected series" laterals in db-ops/transcripts.ts (`:192-222`, `:667-697`) go:
  with curated patterns, "matches but not a member" can only mean excluded. Return NULL
  for suspected_series_* (keep the columns so the API shape is stable).
- `listSuggestedMembers` / `suggestSeriesForTranscript` / `findDuplicateSeries`: remove or
  reimplement over the matcher (suggest = series whose patterns match but which the
  transcript is excluded from — i.e. none useful; simplest: return []).

## 4. Default labels

- A series' default labels = its `label_rules` rows (kind='series', value=`<id>`,
  label_id NOT NULL, enabled). Several per series.
- Member joins → each default label applied with `how='rule'`, `rule_id` set (reuse
  `applySeriesLabel`'s write + activity rows). Member leaves (auto or manual removal,
  move to another series) → delete that transcript's `transcript_labels` whose `rule_id`
  is one of the old series' rules. Label removed from a series → delete its rule and the
  assignments it made. A label someone attached by hand (`how<>'rule'`) is never touched.
- Drop the 2-member threshold, the auto-created `Series/<title>` label, the rename
  follower, and the merge path. `series-label-name.ts` is no longer used for new series.
- Labels are picked or created by path in the UI (`Team/Data`, `AM Briefing/Jacq` —
  creating intermediate parents like the labels API already does).

## 5. Followers

- Follow share = `transcript_shares` row, access `'read'`, `origin = 'series-follow'`
  (add `SHARE_ORIGIN_SERIES_FOLLOW` next to the auditor constant), shared_by = owner,
  ON CONFLICT DO NOTHING, skipped for the owner and when the
  `auditor_share_removals` ledger has ANY row for (transcript, email) — whoever removed
  someone from a meeting, no automation adds them back. Same writer shape as
  `addAuditorShares` (db-ops/auditor-shares.ts) — generalise it rather than copy it.
- Member joins a followed series → every follower gets the share. Member leaves → that
  series' `series-follow` shares for its followers are removed. Follower added → shares
  on every current member; follower removed → their `series-follow` shares on this
  series' members are removed.
- The share DELETE route records a removal of an `origin='series-follow'` share in the
  ledger exactly like an auditor one (origin column filled), and the share dialog
  explains it: "Following <series name>" badge + note, like the auditor note.
- Retranscribe `carryShares` keeps the `series-follow` origin as it keeps the auditor one.

## 6. Permissions & privacy (ABSOLUTE — read .agent-memory/feedback_privacy_caller_scoping_gate.md)

Following grants READ ACCESS to other people's meetings, so:

- **Add/remove followers: auditors only** (`AUDITORS` in lib/auditor-policy.ts). Any
  follower may remove THEMSELVES.
- **Edit patterns/priority of a series that has followers: auditors only.** (Else anyone
  could widen a followed series to `.*` and pull every meeting to its followers.)
  Series without followers: anyone may create and edit name, description, patterns,
  priority, labels.
- Delete a series: its creator or an auditor.
- Everyone sees every series: name, description, patterns, labels, followers,
  auto-import status. `visibleSeriesIds` becomes "all series".
- Members are never listed beyond the caller's access: series detail/members return
  only meetings the caller owns or has a share on; counts are "visible to you".
- `POST /api/series/preview` `{patterns}` → `{ matched, visibleToYou, sample[≤10 of the
  caller-visible ones] }` — the global `matched` count is a number only.
- Manual add (`POST /api/series/:id/members`): caller must own or edit the meeting.
  Remove (`DELETE`): scoped to `:id` (fix: today it ignores `:id`), caller owns or edits
  the meeting; `remember=1` writes an exclusion.
- Merge and retro-attach routes: 410 Gone.

## 7. Auto-import

Keep `series.auto_import` + the sweep/fire-once log machinery; replace how a series
finds its CALENDAR occurrences:

- `computeSweepSkeleton` (series-occurrences.ts:603-662): instead of the live Calendar
  `q=title` search + key filter, read the enabler's own `calendar_event_cache` rows
  (`user_id = byUserId`, after `since`, ended), filter with the matcher
  (`factsFromCalendarRow`), and feed the matched rows' meeting codes (Meet) / `teams-…`
  codes (Teams, join URL via the existing gmeet_meeting_cache lookup) into the existing
  artifact steps. Own-calendar rows only — the own-token rule stands.
- Imported cross-reference (`loadImportedCandidates`) = the series' members.
- `seriesOwnerFor` (auto-import-plan.ts:91-108), `seriesOwnsOrOptsOut`
  (account-auto-sync.ts:246-254) and the calendar chips' `findSeriesByRecurringBaseIds` /
  `findSeriesByMeetingCodes` (calendar-meetings/route.ts:399, calendar/events/route.ts:359):
  evaluate the matcher on the occurrence's facts (title, attendees, organizer,
  recurring). Pass title + attendees from the account-sync caller (it passes only code
  + recurring id today).
- Imports an auto-import makes join the series via `syncSeriesForTranscript` at ingest
  (patterns match the same title) — no special path.

## 8. Rollout (run by the orchestrating session, not the builder)

1. Migration 053 (`scripts/vm-apply-migration.sh 053`).
2. Deploy.
3. `scripts/curated-series-reset.sql` (one transaction): `DELETE FROM label_rules WHERE
   kind='series'`; delete `labels` whose path starts `Series/` (assignments cascade);
   `DELETE FROM series` (cascades keys/members/exclusions/log).
4. `scripts/curated-series-seed.ts --apply` (bun, `--conditions=react-server`, on the VM):
   creates the seed set below through the db-ops layer (not raw SQL — so labels, rules
   and the follower path are the real code), carries `auto_import` from the backup
   values, adds followers, then `rematchAll()` and prints per-series member counts.
   `--dry-run` prints what each series would match without writing.

### Seed set (Alok approved 2026-10-06)

| # | Name | Title patterns (regex, case-insensitive) | Default labels | Auto-import | Followers |
|---|---|---|---|---|---|
| 1 | AI - Daily | `^AI - Daily` | Team/AI | old #18 (alok) | alok |
| 2 | Integration Cadence | `^Integration Cadence` | Team/Integration | old #6 (alok) | alok |
| 3 | Data Cadence | `^Data Cadence` | Team/Data | old #9 (alok) | alok |
| 4 | Data scrum | `^Data scrum` | Team/Data | | alok |
| 5 | Lothal scrum | `^Lothal scrum` | Team/Data | | alok |
| 6 | Data weekly / Data QA | `^Data (weekly\|QA)\b` | Team/Data | | alok |
| 7 | DevOps Scrum | `^DevOps (Engineering )?Scrum` | Team/DevOps | old #24 (yadu) | alok |
| 8 | Preet Scrum | `^Preet Scrum` | Team/Preet Scrum | | alok |
| 9 | Analytics Cadence | `^Analytics (Cadence\|transition)` | Team/Analytics | | alok |
| 10 | AM Briefing: Jacq | `spanish.*perf?ume`, `^AI AM$` | AM Briefing/Jacq | | alok |
| 11 | AM Briefing: Kawen | `^Weekly MCAP, SL`, `^Ivan / Ka Wen`, `^APP Bookings`, `^Spicy Steel Sats`, `^COG/MCAP weekly round up`, `^Weekly COG and HF` | AM Briefing/Kawen | | alok |
| 12 | AM Briefing: Aniq | `^Cool Beers` | AM Briefing/Aniq | | alok |
| 13 | AM Briefing: Swaralee | `Paper, ?Nuts`, `Nuts and Yogurt` | AM Briefing/Swaralee | | alok |
| 14 | AM Briefing: SiQian | `^Juggling the Customers`, `^DKSH Weekly Review` | AM Briefing/SiQian | | alok |
| 15 | AM Briefing: Iman | `^Last Drills Before Spills` | AM Briefing/Iman | | alok |
| 16 | CS Briefing: Ain/Aniq | `^CS-Freshdesk Weekly Review`, `^Freshdesk Status Reviews`, `^Ain <> Ivan` | CS Briefing | | alok |
| 17 | LP-Global Weekly Catch Up | `^LP-Global ?<> ?Trames Weekly` | Customers/LP Global/Weekly catch-up (exists) | old #5 (alok) | alok |
| 18 | MCAP Phase 2 Weekly | `^MCAP x Trames`, `^Weekly connection for Phase 2` | Customers/MCAP, Kawen | old #32 (kawen) | alok |

Descriptions: one line each (e.g. #10 "Ivan's recurring 1:1s with Jacqueline — weeks
1/3/4 and the Monday-review variant with Harshil"). Priorities: the AM/CS briefings 50,
the rest 100. Not seeded (owner undecided): CADENCE, "Weekly JCH / HAPBev / Geodis".

## 9. Change map (from the codebase survey)

series.ts (createSeries 149, updateSeries 169, setSeriesAutoImport 277, deleteSeries 233,
addKeys 651, addMember 702, removeMember 722, visibleSeriesIds 40-75,
listSuggestedMembers 798, suggestSeriesForTranscript 858, findDuplicateSeries 426,
recordAutoImportFire 350); series-attach.ts 23-106; series-keys.ts; series-labels.ts
(ensureSeriesLabel 119, applySeriesLabel 198, syncSeriesLabelOnMemberAdd 258, rename 274,
merge 336, delete 380); label-visibility.ts 21-34 + db-ops/labels.ts 289 (Series/ hiding
— generalise or drop); series-auto-import.ts 65-268; series-occurrences.ts 77, 267-303,
603-662, 705, ~866; auto-import-plan.ts 91-108; account-auto-sync.ts 246-254, 596;
routes app/api/series/** (route.ts, [id], members, merge, occurrences,
occurrence-counts, retro-attach), app/api/transcripts/[id]/series; UI app/series/page.tsx,
components/series-dialog.tsx, components/series-badge.tsx, transcript page 344/3080/4196,
transcript-table 2082/2666, calendar-meeting-rows 621; CLI cli-subcommand-src/index.ts
2497-2574.

## 10. As built (2026-10-06, rolled out 19:29–19:40 SGT)

Commits 96f111f (A) · 420f8ad (B) · bee50a3 (C) · 38a8ad2 (D) · e8bd385 (review fixes).
Migration 053 applied 19:29 SGT; deployed e8bd385 (blue); reset removed 57 series /
383 members / 221 keys / 42 `Series/*` labels (365 assignments) / 40 rules; seed
created #66–#83 (318 members, 82 new follow shares for alok@, 315 rule labels — the
18 LP-Global rows already carried the same label by hand).

Deviations from §1–§8 decided in review (all privacy-motivated):
- A FOLLOWED series beats any unfollowed series in a match, regardless of priority
  (`compareSeriesPrecedence`) — otherwise anyone could steal members from followers
  with a same-pattern, lower-priority series. Follow/unfollow re-runs matching.
- Deleting a followed series is auditor-only (its creator could otherwise drop the
  followers' access).
- A person taking a meeting out of a followed series ("not this series", or moving it
  by hand) records the lost follow shares in `auditor_share_removals`
  (origin `series-follow`, removed_by = that person). A detach the patterns undo at
  once is not recorded.
- `POST /api/series/preview`: the org-wide `matched` count goes to auditors only
  (null for others) — a regex + a global count is an existence oracle.
- Builder's own (see its commit messages): catastrophic-backtracking regexes refused;
  merge / retro-attach answer 410; suspected-series columns always NULL; `Series` root
  label removed by the reset.

Not verified: the UI in a browser; the first auto-import sweep over the curated
series (fire-once log was reset — watch for duplicate imports on the first pass).
