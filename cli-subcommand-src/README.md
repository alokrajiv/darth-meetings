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
| `list --scratch` | `GET /api/transcripts?scratch=1` — the caller's temporary (scratch) rows, legacy shape like `?trash=1`; refuses every other filter flag (exit 1). Rows carry boolean `scratch`; `get <id>` prints `scratch: yes` when set |
| `text / get / notes / report / audio / frame / attachments / set-*` | unchanged |
| `trash <id>` | `GET /api/transcripts/:id` pre-check (owner, not already `deleted_at`, not an `uploading`/`waiting` placeholder — those would be deleted for good) then `DELETE /api/transcripts/:id` → `{ok,trashed:true}` (soft delete; server 403 non-owner / 404). The CLI never sends `?permanent=1` and never DELETEs a trashed row — permanent delete is web-only, by design |
| `restore <id>` | `POST /api/transcripts/:id/restore` → `{ok}` (403 non-owner, 404, 409 "Not in the trash") |
| `upload <file> [--event <ref>] [--title] [--language] [--scratch] [--resume] [--wait] [--timeout]` | **media ≤ 8 MiB and every text doc: one shot** — media → `POST /api/transcripts?event=&language_code=[&scratch=1]` with the raw file body (`Bun.file`, streamed) + `x-filename` / `content-type`; text docs (`.vtt .srt .txt .md .docx .pdf …`) → `POST /api/transcripts/import-text?event=[&scratch=1]` same headers. **Media > 8 MiB: the resumable session family** (see below). No `--report` / `report_pref` from the CLI (design rule above: the CLI never starts an AI run; uploads get the default summary notes, a detailed report is a human's web-UI ask — `--report` on `upload` exits 1 with that hint; `auto-sync --report` / `series set --report` stay, they mirror settings). `--scratch` → `scratch=1` / `scratch:true` (temporary row: hidden from the main listing, web Temporary tab, auto-trashed 30 days after creation unless kept or linked; sent even with `--event`, the server decides). `?event=` / `eventRef` is a meeting code (latest PAST occurrence) or an exact event key (`key` of a calendar row) resolved server-side from the caller's own calendar cache (`lib/server/linked-event-ref.ts`). `--title` → `PATCH /api/transcripts/:id {title}`. `--wait` polls `GET /api/transcripts/:id` (re-resolving via `/api/meetings/resolve?any=` on 404) until `status=completed`, then up to 4 more min until `speaker_id_status` is completed/error, then prints `speakers`. The result lines / `--json` shape are the same on both paths |
| `upload` > 8 MiB (resumable) | (1) stream-sha256 the file (`Reading …` on stderr); fingerprint = `cli:v1:<sha256>` (content-derived, so the same file resumes across runs and renames). (2) `POST /api/uploads {fingerprint,size,filename,contentType,languageCode?,eventRef?,scratch?,via:'blob',sha256}` → `{id, via:'chunks'\|'blob', chunkSize, chunkCount, received[], resumed, transcript, blob?}`. **The server decides `via`**: `blob` when `DARTH_UPLOADS_ACCOUNT` is set on the host (prod), else `chunks`. (3a) `chunks`: `PUT /api/uploads/:id/chunks/:idx` raw body + `x-chunk-sha256` for every idx not in `received[]`, 4 in flight, per-chunk retry ×40 with capped backoff (401/403/409/413 abort; 404/410 = session gone → restart once). (3b) `blob`: `HEAD` the SAS URL (already committed → skip), `GET ?comp=blocklist&blocklisttype=uncommitted` → skip the 4 MiB blocks Azure already holds (that IS the resume), `PUT ?comp=block&blockid=` × `ticket.parallel`, `PUT ?comp=blocklist` to commit (`x-ms-blob-content-type`); retries inside a 30-min window with the 1/2/4/8/15/30 s schedule; an expired / 401 / 403 SAS is renewed by re-opening the session (same fingerprint → same session → same blob). (4) `POST /api/uploads/:id/complete` (no client timeout: the server pulls the blob + ingests to AAI first) → `{transcript}` or `{status:'done',transcriptId}` (then `GET /api/transcripts/:id`); 409 `{missing}` → re-open + re-send those chunks; 409 `{notCommitted}` → re-sync blocks; 409 `completing` or a lost reply → poll `GET /api/uploads/:id` every 3 s until `done`/`failed`; 503 (VM pull hiccup, session reopened) → repeat; 404/410 → restart once. **Ctrl-C** prints the session id + how much is already there and exits 130; the session stays resumable 24 h — re-running the same command on the same file continues (`--resume` only adds a note when there is nothing to resume). **Local ledger** `$DARTH_CONFIG_DIR/meetings-uploads.json` (default `~/.darth/`, 24 h TTL) maps fingerprint → session id: before opening, `GET /api/uploads/:id` on the prior session — `done` → use its transcript (a Ctrl-C during "Finalizing…" otherwise re-uploads and DUPLICATES, since the server only resumes OPEN sessions), `completing` → poll it, anything else → fresh. Progress: stderr, live `\r` line on a TTY, one line per 10 % otherwise, silent under `--json` |
| `offline plan [<id,…>]` | `GET /api/offline/plan[?ids=a,b]` → `{prefs, buildId, meetings:[{id,title,recordedAt,createdAt,durationSec,provider,rev,media:{hasLocal,isVideo,parts:[{part,filename,isVideo,bytes}]}}]}`. Without ids the CLI applies the web app's auto-pin ladder locally (`src/lib/offline/offline-sync.ts` `desiredAutoLevels`: newest `prefs.transcripts` at transcript, of those with `hasLocal` the first `prefs.audio` at audio, of those with video the first `prefs.video` at video; max wins) and prints one line per meeting with the level + stored recording bytes; with ids it prints availability and lists absent ids (a device unpins those). `--json` = the response verbatim |
| `offline prefs` / `offline prefs --set k=n[,k=n]` | `GET /api/offline/prefs` → `{prefs,defaults,max}`; `PUT /api/offline/prefs {transcripts?,audio?,video?}` (partial; server clamps to `max`). The write needs read+write AND `--i-have-got-consent-from-human-user` (account-settings write, same contract as `notify` / `auto-sync`) |
| `link <id> <ref>` | `POST /api/transcripts/:id/link-event {meetingCode}` or `{eventKey}` — server resolves the event, merges it into `gmeet_context`, sets `recorded_at`, fills an empty title, registers people, mints the backend Google token for the Meet-actuals enrichment, and re-runs the speaker-ID pass with the attendees unless names are confirmed / a pass is running (`reguessing` in the reply) |
| `set-date <id> <when>` | `PATCH /api/transcripts/:id {recordedAt}` — ISO / `YYYY-MM-DD HH:mm` (machine-local) / `YYYY-MM-DD` (local noon) |
| `speakers <id>` | `GET /api/transcripts/:id` + `GET /api/transcripts/:id/speakers` → one line per diarized speaker: confirmed name or guess (name, confidence, source, id-pass) + the pass status |
| `set-speakers <id> A=Name …  [--clear]` | `GET` then `PUT /api/transcripts/:id/speakers {speakerLabels}` — merges into the existing labels (`--clear` drops them first); the server enrols voiceprints from confirmed names |
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
- `calendar --view all` rows carry `key` (`<eventId>|<startIso>`) — the exact
  reference for `upload --event` / `link` (printed under `--details`, always in
  `--json`). A meeting code also works but resolves to the latest PAST
  occurrence, so recurring calls need the key for an older occurrence.
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
cd ~/crp-workspace/darth/cli
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

Same rule applies to `../holocrons/cli-subcommand-src/` and
`../tasks/cli-subcommand-src/` — one deploy ships all three, since
build.sh copies every subcommand folder.
