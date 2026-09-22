# NOTE for the meetings agent — the Google account link is moving to darth-auth (Alok, 2026-09-22)

Written from a tasks-repo session; nothing in this repo was edited. Plan + contract:
`~/crp-workspace/darth/plans/connectors/README.md` and `CONTRACT.md` (section A). State on 2026-09-22: the auth side
is being BUILT locally, nothing is deployed, and this app keeps working exactly as it does today until the steps
below are done here.

## What Alok decided

1. darth-auth becomes the one place people connect external accounts (`auth.darth-internal.trames.io/connections`).
2. The existing links are REPLICATED into auth first: `auth/scripts/import-links.ts google` copies
   `meeting_whisperer_prod.google_accounts` rows (refresh token decrypted with `GOOGLE_TOKEN_ENC_KEY`, re-encrypted
   into auth's `account_links`, same two OAuth clients `sg` / `eng`, so nobody re-consents). Source rows are not
   modified. Until this app switches over, both copies of a refresh token are live and both work.
3. Then this app stops doing Google auth itself and stops using its own table, and sends people to auth instead.

## What this repo has to do (in a meetings session, after the auth side is deployed and the import has run)

- **Stop reading `google_accounts` for tokens.** Replace the token minting in `src/lib/server/google-oauth.ts` (and
  whatever the background poller calls) with one service-to-service call:
  `POST {DARTH_AUTH_INTERNAL}/api/links/google/token {userId, group}` with this app's `dapp_` token →
  `{token, expiresAt, accountLabel, scopes}`. Groups this app needs: `calendar` (calendar.events.readonly +
  meetings.space.readonly), `drive`, `directory`. 404 = not linked, 403 = that group not granted, 410 = link dead
  (person must reconnect on auth). The app has to be allow-listed on auth: `LINKS_TOKEN_APPS` gets
  `google:calendar=<this app's dapp_ name>;google:drive=…;google:directory=…`.
- **Stop doing the OAuth dance here.** Settings → "Google account" becomes a status card (read
  `GET {AUTH}/api/links/google/status` as the signed-in person) whose Connect / Reconnect button goes to
  `https://auth.darth-internal.trames.io/connections?return=<this settings URL>`. Remove the connect + callback
  routes and the client secrets from this app's env once the soak is over. The browser GIS popup path (1-hour tokens,
  no server involvement) is a separate decision — keep or drop, but it must not write `google_accounts`.
- **Poller bookkeeping stays here.** `last_poll_at`, `gmeet_reminders` and anything else that is about THIS app's
  polling is not a credential and does not move; if it lives on `google_accounts` today, move those columns to a
  table of this app's own before the table is retired.
- **Same for the Microsoft card.** Settings → "Microsoft account" today round-trips to tasks `/ms` and reads
  `/api/ms/internal/link-status`; it will point at `/connections` and `GET {AUTH}/api/links/microsoft/status` once
  tasks has switched (tasks has its own note). `/api/ms/internal/chat-call-events` stays on tasks.
- **Do NOT call Google's revoke endpoint from here any more.** A revoke drops the whole user↔client grant, i.e. it
  would also kill the copy auth holds (and the person's Gmail grant if they added one). Disconnect = go to auth.
- **Never request Gmail scopes here.** Gmail is an extra clearance that exists only on auth
  (module `gmail` + the person's own tick + a `gmail` token scope) and only `connectors` may fetch a Gmail token.

## Order and safety

Dual-run: auth serves tokens while `google_accounts` stays untouched as the fallback; switch the poller last and
soak longest (it runs unattended). Drop the table and `GOOGLE_TOKEN_ENC_KEY` only after Alok says the soak is over.
Delete this note when the switch is done and recorded in `plans/meetings-tech-debt.md`.
