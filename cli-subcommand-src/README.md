# meetings subcommand — source of truth for `darth-cli meetings`

This folder is copied into `darth-cli/src/subcommands/meetings/` **at darth-cli
build time**. Editing files here does NOT ship anything by itself — installed
CLIs keep running the old bundle until darth-cli is rebuilt and deployed.

Design rule for this subcommand: **no AI commands.** The CLI is used mostly by
people's AI agents; it exposes deterministic primitives (list/get/text/search/
audio/frame/attachments/labels + set-notes/set-report/set-title/label write-
back) and the calling agent brings the intelligence with its own tokens.
`skill` prints the agent workflow guide.

## Commands (quick map → endpoints)

| command | endpoint(s) |
| --- | --- |
| `list` (no flags) | `GET /api/transcripts` — legacy full array, **byte-identical output, never change** |
| `list [FILTERS]` | `GET /api/transcripts?v=2&tab=all&days=60&minRows=200&tz=…&<filters>` paged via `cursor=nextCursor` until `hasMore=false`, flattened to one row list, same columns as legacy |
| `search <q> [people filters]` | `GET /api/transcripts/search?q=…&participant=…&organizer=…&provider=…&speaker=…` |
| `export --out-dir <dir> [FILTERS]` | list v2 drain (as above) → per row `GET /api/transcripts/:id/content` + `/speakers` |
| `calendar [--view unimported\|norec] [FILTERS]` | `GET /api/calendar-meetings?view=…&<filters>` paged the same way |
| `calendar --view all [--from D] [--to D] [--details] [--cached] [FILTERS]` | `GET /api/calendar/events?from=&to=&tz=&<filters>[&sync=0]` — the caller's FULL calendar (past + upcoming, imported or not, no-link events too), ascending, one response (server cap 5000 rows, max 366-day window); the server re-reads the window live from Google under the caller's own link unless `sync=0`, writing back to their calendar cache. Rows carry `imported:{id,status,accessible,mine,title,ownerEmail,url,notes,report}` (notes/report = ready\|running\|error\|none), `evidence:{recording,transcript,preparing,geminiNotes}`, `meetingUuid`/`meetingUrl` (stable /m link, minted server-side), `series:{id,title}`, `description`/`location`/`calendarUrl` (migration 039) |
| `text / get / notes / report / audio / frame / attachments / set-*` | unchanged |
| `notify` / `notify <kind> on\|off` | `GET` / `PUT /api/notify-prefs` — settings writes (this and `auto-sync off\|mine\|all`) require `--i-have-got-consent-from-human-user` |
| `labels` | `GET /api/labels?counts=1` — human = indented tree (`name (count_visible · n direct) #id color`), `--json` = the flat `labels` array verbatim |
| `label <id> <label>` | resolve `<label>` against `GET /api/labels`; if the path is new → `POST /api/labels {path}` (prints `created …` per segment); then `POST /api/transcripts/:id/labels {labelId}` |
| `unlabel <id> <label>` | resolve → `DELETE /api/transcripts/:id/labels/:labelId` |
| `list --label <label\|none> [--exact] [FILTERS]` | resolve → listing v2 with `&label=<id\|none>&exact=1` (the other filters compose); rows get a `{path,path}` column |
| `export --label <label\|none> [--exact] --out-dir <dir>` | same listing drain, then per row `GET /api/transcripts/:id/content` + `/speakers` + `/api/transcripts/:id` (notes/report) → folder mirror (below) |
| `label-create <path> [--color #rrggbb]` | `POST /api/labels {path, color?}` → prints `created …` or `exists …` |
| `label-rename <label> <newName>` | resolve → `PATCH /api/labels/:id {name}`; prints every rewritten sub-label path from `updated[]` |
| `label-mv <label> <newParent\|/>` | resolve both → `PATCH /api/labels/:id {parentId: id\|null}` (server 409s cycles / dup names / depth > 6) |
| `label-rm <label> [--cascade]` | resolve → `DELETE /api/labels/:id[?cascade=1]`; the CLI refuses locally (exit 1) when the label has sub-labels and `--cascade` is absent (the server 409s too) |

## IDs, files and flags

- `<id>` is `assemblyai_id` from `list` (`teams-…`, `gmeet-…`, `ext-…`, or a
  bare AAI uuid) — the same id as the web URL `/transcript/<id>`.
- `calendar` rows carry no transcript id (they are NOT in the archive); the
  `[meeting-code]` tail (`teams-…` / Meet code) is printed for cross-reference.
  Importing stays a web-UI action (caller's own Google/Microsoft token).
- `calendar --view all` rows DO carry the transcript: status `imported` +
  a `→ <id>` tail when the occurrence is in the archive (anyone's live
  import; `imported(no-access)` and no id tail when the caller can't open it) — `text <id>` from there. Default window 7d back →
  30d ahead; one bound → 90 days from/to it. `--cached` skips the live Google
  read (faster, offline-safe, but only what past sweeps captured: −7d→+24h).
- **Filter flags** (shared; all AND together, comma inside a value = OR,
  case-insensitive substring; names are the server contract — do not rename):
  `--participant` (organizer email, attendee emails + display names, and on
  archive rows speaker names; `@domain` = whole company), `--organizer`
  (organizer email), `--provider teams|gmeet|upload`, `--speaker` (archive
  only: list/search/export), `--q` (2+ chars; list/export = title/filename/
  description/notes/full text, calendar = title/organizer/attendees; `search`
  takes its query positionally), `--from/--to YYYY-MM-DD` (inclusive, in the
  config `timezone` else the machine's — sent as `tz=`). Flags a command does
  not support are rejected with exit 1 rather than silently ignored (`search`
  has no `--from/--to/--q`; `calendar` has no `--speaker`). Bad `--provider`
  values are rejected locally (the server also 400s).
- `export` file naming: `<dir>/<YYYY-MM-DD>-<title-slug>-<id>.txt` (or `.json`
  with `--format json`). Date = `recorded_at || completed_at || created_at`
  (UTC day, same as the `list` column); slug = lower-cased, non-alnum → `-`,
  ≤60 chars, `untitled` fallback; `<id>` keeps names unique. `.txt` is the
  exact `text <id>` rendering plus a trailing newline (one shared renderer —
  `fetchTranscriptText`). `.json` = `{id,title,date,recorded_at,duration,
  speaker_count,provider,access,owner_email,participants,lines:[{ms,ts,
  speaker,text}],text}`. Existing files are skipped unless `--force`; rows not
  in `status=completed` are skipped; one failing transcript is reported and
  does not abort the run (exit 1 at the end if any failed). `--json` prints a
  manifest `{outDir,format,matched,written,skipped,failed}` instead of the
  per-file lines.
- `list --json` / `export` rows carry `participants: string[]` (organizer
  first, then attendee emails) and `labels: [{id,name,path,color}]` — both
  fields come from listing v2 only, so the legacy no-flag `list --json` has
  neither (and its text lines never grow the `{…}` labels column).

## Labels (`docs/labels-design.md` §6)

- `<label>` anywhere = a path (`Customers/LP Global`, **case-insensitive** —
  matched on the server's `path_key` = `lower(path)`) or `#<id>` as printed by
  `labels`. Unknown paths exit 1 with up-to-5 "did you mean" rows; only
  `label <id> <path>` and `label-create` create missing segments (whole
  chain, one `POST /api/labels {path}`).
- `label` / `unlabel` / `label-*` call `ctx.requireWrite()` first (read-only
  meetings token → exit 4 before any network hop). `label`/`unlabel` also need
  owner-or-edit access on the transcript (server 403 otherwise).
- `--label` / `--exact` are accepted by `list` and `export` only; `search`
  and `calendar` reject them (exit 1), and `--exact` without `--label` is an
  error. `none` = unlabelled meetings (`label=none`).
- `export --label …` switches from the flat file naming to a **folder
  mirror**: `<dir>/<label path>/<YYYY-MM-DD> <title> (<id>)/` containing
  `meta.json` (row meta + `labels` + notes/report status), `text.txt` (exact
  `text <id>` rendering + trailing newline), `notes.md` / `report.md` (only
  when the transcript has them), plus `lines.json` with `--format json`. A
  transcript lands once per label it carries that sits at/under the filter
  label (only the filter label itself with `--exact`); `--label none` writes
  under `<dir>/_unlabelled/`. Folder segments keep case and spaces but swap
  `/ \ : * ? " < > |` for `-` (120-char cap on label segments, 80 on the
  title). Skip/`--force`/partial-failure semantics are the flat export's,
  keyed on the folder's `text.txt`; `--json` prints the manifest with
  `layout: "labels"`.
- `labels` prints `count_visible` (subtree-inclusive, visible to the caller)
  and adds `· n direct` when `count_direct` differs. Tree order = server
  `path_key` order; orphans (parent not in the listing) print at top level.

## After changing anything in this folder

```bash
cd ~/workspace/darth-cli
# 1. Bump src/core/version.ts — MANDATORY. `darth-cli update` (and the passive
#    update check) compare versions; an unbumped bundle never reaches users.
#    New command/feature → minor; fix/copy tweak → patch.
# 2. Build + deploy (copies this folder in, bundles, rsyncs cli-dist to .6,
#    restarts darth-auth, health-checks):
bash scripts/deploy.sh
# 3. Commit + push BOTH repos: darth-cli (version bump) and this repo (source).
# 4. Update your own install and verify:
darth-cli update && darth-cli --version && darth-cli meetings --help
```

Everyone else picks it up via the CLI's passive update check (5-min TTL) or
`darth-cli update`.

Same rule applies to `../darth-artifacts/cli-subcommand-src/` and
`../darth-plagueis/cli-subcommand-src/` — one deploy ships all three, since
build.sh copies every subcommand folder.
