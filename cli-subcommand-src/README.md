# meetings subcommand — source of truth for `darth-cli meetings`

This folder is copied into `darth-cli/src/subcommands/meetings/` **at darth-cli
build time**. Editing files here does NOT ship anything by itself — installed
CLIs keep running the old bundle until darth-cli is rebuilt and deployed.

Design rule for this subcommand: **no AI commands.** The CLI is used mostly by
people's AI agents; it exposes deterministic primitives (list/get/text/search/
audio/frame/attachments + set-notes/set-report/set-title write-back) and the
calling agent brings the intelligence with its own tokens. `skill` prints the
agent workflow guide.

## Commands (quick map → endpoints)

| command | endpoint(s) |
| --- | --- |
| `list` (no flags) | `GET /api/transcripts` — legacy full array, **byte-identical output, never change** |
| `list [FILTERS]` | `GET /api/transcripts?v=2&tab=all&days=60&minRows=200&tz=…&<filters>` paged via `cursor=nextCursor` until `hasMore=false`, flattened to one row list, same columns as legacy |
| `search <q> [people filters]` | `GET /api/transcripts/search?q=…&participant=…&organizer=…&provider=…&speaker=…` |
| `export --out-dir <dir> [FILTERS]` | list v2 drain (as above) → per row `GET /api/transcripts/:id/content` + `/speakers` |
| `calendar [--view unimported\|norec] [FILTERS]` | `GET /api/calendar-meetings?view=…&<filters>` paged the same way |
| `text / get / notes / report / audio / frame / attachments / set-*` | unchanged |

## IDs, files and flags

- `<id>` is `assemblyai_id` from `list` (`teams-…`, `gmeet-…`, `ext-…`, or a
  bare AAI uuid) — the same id as the web URL `/transcript/<id>`.
- `calendar` rows carry no transcript id (they are NOT in the archive); the
  `[meeting-code]` tail (`teams-…` / Meet code) is printed for cross-reference.
  Importing stays a web-UI action (caller's own Google/Microsoft token).
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
  first, then attendee emails) — that field comes from listing v2 only, so the
  legacy no-flag `list --json` does not have it.

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
