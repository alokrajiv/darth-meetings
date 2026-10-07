# Tech debt: one person, several email addresses (2026-10-07)

Status: OPEN. Raised by Alok during the curated-series v2 rollout. Owner: unassigned
(hand to an agent; tell the series session when done — see "Waiting on this" below).

## The problem

Darth Meetings identifies a person by **the one email they signed in with** (Trames SSO
→ `user.email`) plus their SSO user id. Access is matched on that single address:
`transcript_shares.shared_with_email = <login email>` (`db-ops/transcript-access.ts`
`resolveAccess`, and ~73 other `shared_with_email` references across ~30 files).

Some people have two company addresses, e.g. Preet Singh:
- signs in as `preet.singh@trames-engineering.com` (the app knows this one — it is in
  `transcript_activity`);
- is invited to calendar events as `preet.singh@trames.sg` (she organises Integration
  Cadence and Preet Scrum under it).

Invitee auto-shares (`lib/server/auto-share.ts` `shareWithInternalInvitees`) are written
to the **calendar** address. So today Preet most likely **cannot open any meeting shared
to her through an invite** — the share exists, but under an address her login never
matches. Nothing errors; the meetings just aren't there for her.

There is no alias table anywhere in this app.

## Evidence (prod dry run, 2026-10-07 ~14:00 SGT, nothing written)

`scripts/series-ownership-seed.ts` dry run with Preet as owner of two curated series,
using her login address:

| series | members now | members with owner preet.singh@trames-engineering.com |
|---|---|---|
| #67 Integration Cadence | 61 | **0** |
| #73 Preet Scrum | 9 | **0** (and Alok's 9 follow shares would be removed) |

A series reaches only meetings its owner can open (spec `docs/curated-series-spec.md`
§11.2), so this is a direct read-out of what Preet can open: none of her own calls.

To size it: list people whose `transcript_activity.user_email` (login) differs from the
addresses they appear under in `calendar_event_cache.attendees` /
`gmeet_context.attendees` (same display name, other internal domain). Internal domains:
`lib/internal-domains.ts` (`trames.sg`, `trames-engineering.com`).

## What a fix must do

1. **A verified source of "these addresses are the same person".** Never user-entered
   or guessable — whoever can add an alias can read everything shared to it. Candidates,
   best first:
   - darth-auth / SSO: the account's verified emails (Cognito `email` + any verified
     alternates; Google Workspace user aliases if the directory exposes them);
   - an admin-maintained table (`person_emails (canonical_user_id, email, added_by,
     added_at)`), edited only by an admin, like the `auditors` table (migration 054).
   Decide where it lives: identity is cross-app (meetings, tasks, holocrons, chat all
   key on email), so darth-auth is the natural home, with meetings reading it. Check
   `../auth` before building a meetings-only table.
2. **Every access check matches ANY of the caller's addresses**, not just the login
   one: `resolveAccess` / `canAccessTranscript`, the listing (`db-ops/transcripts.ts`
   `listVisibleToUser`, `listPagedForUser`), search (`db-ops/transcript-search.ts`,
   `meeting-search.ts`), recordings/clips, labels visibility, offline plan, calendar
   layer (`calendar-event-cache.ts`, `occurrence-join.ts`, `imported-occurrences.ts`),
   share suggestions, series (`db-ops/series.ts` `seriesVisibleTo`, owner/editor/follower
   matching in `lib/series-permissions.ts`, reach in `lib/server/curated-series.ts`
   `seriesReaches` / `ownerMayActOn`), the share-removal ledger, the auditors table.
   Grep `shared_with_email`, `user.email`, `owner_email`, `.email ===` — the list above
   is a start, not exhaustive.
3. **Writers may stay single-address** (a share is still written to the invited
   address), as long as every reader resolves aliases. Do NOT rewrite existing share
   rows.
4. **Self-matches use all addresses too**: "is the caller the owner/follower/invitee",
   "don't share a meeting with its own owner" (`meetingOwnerEmails` in
   curated-series.ts already collects every address a user id has used —
   generalise that), auditor checks.
5. **The privacy gate holds**: read
   `.agent-memory/feedback_privacy_caller_scoping_gate.md` first. Add tests that a
   person with alias X sees exactly what is shared to X, and someone WITHOUT the alias
   sees nothing new.

## Not in scope

- Merging two SSO accounts into one user id (if Preet ever signs in under both
  addresses she has two user ids; ownership of meetings stays per user id — note it,
  don't solve it here unless darth-auth already supports linking).
- External (customer) addresses — internal domains only.

## Waiting on this

- Curated series #67 Integration Cadence and #73 Preet Scrum: Alok wants Preet as
  owner. Until aliases work, the proposed interim (not yet confirmed by Alok) is Ka Wen as owner with Preet
  as editor + follower under `preet.singh@trames-engineering.com` (follow shares give
  her real access). When this is fixed, tell that session (Alok relays) so ownership
  can move to Preet — re-run the seed dry run first and check members don't drop.
- Ankit (`ankit@trames.sg`) has never opened Darth Meetings under either address, so
  his series (#68–#70) wait on him signing in once — unrelated to aliases, but check
  his addresses while you're here.

## Addendum (2026-10-07 ~14:00 SGT): organizers are not shared their own meetings

Alok decided `@trames.sg` is the true identity, and series owners may now be addresses
that never signed in (7f52596). With Preet as `preet.singh@trames.sg`, Integration
Cadence (#67) would still drop **61 → 30**: the 30 older occurrences (2025-08 → early
2026) have Preet as calendar ORGANIZER but not in the attendee list, and
`shareWithInternalInvitees` only shares with attendees — so the organizer of a meeting
got no share of it. (One more member has no invite at all — a tray/manual upload.)

Fix together with the alias work: treat the internal organizer as an invitee in
`lib/server/auto-share.ts`, plus a backfill of organizer shares for existing linked
meetings (origin like the invitee arm). Then re-run the ownership seed dry run for #67
(`OWNERSHIP` row already says Preet) and apply only if members stay 61.

Applied as of this addendum: every seeded series except #67, which stays owned by
alok@trames.sg (its members and labels untouched).
