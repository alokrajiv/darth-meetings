/**
 * darth-cli subcommand: meetings — lives in the darth-meetings repo,
 * copied into darth-cli/src/subcommands/meetings/ at CLI build time.
 * Talks to meetings.darth-internal.trames.io with the dth_ bearer.
 *
 * Design principle: NO AI commands here. The CLI ships deterministic
 * primitives (list/get/search/download/frame-grab/write-back) and the
 * caller's own AI agent brings the intelligence — their tokens, their spend.
 */
import type { Ctx, Subcommand } from "../../core/types";
import { parseArgs, str } from "../../core/args";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HELP = `darth-cli meetings — meeting transcripts, notes & recordings (darth-meetings)

USAGE
  darth-cli meetings <command> [args] [--json]

AI agents: run 'darth-cli meetings skill' FIRST — it explains the intended
agent workflow (fetch text → think with YOUR model → write notes back).

READ
  whoami                          Identity + effective scope as the service sees it
  list [FILTERS]                  Transcripts you own or shared with you (the
                                  archive). With no filter flags: everything,
                                  legacy shape. With filters: server-side
                                  filtered + paged until exhausted, same columns
  get <id>                        One transcript's metadata + AI-notes/report status
  text <id>                       Full transcript as "[mm:ss] Speaker: …" lines
                                  (confirmed speaker names applied; grep/regex this)
  notes <id>                      Print the meeting-notes markdown
  report <id>                     Print the detailed-report markdown
  search <query> [FILTERS]        Server-side deep search (title, filename,
                                  description, notes, full text) with snippets;
                                  --regex = query is a case-insensitive POSIX
                                  regex (5s server cap; bad pattern → clear
                                  error). --participant/--organizer/--provider/
                                  --speaker narrow the hits (no --from/--to/--q)
  export --out-dir <dir> [FILTERS] [--format text|json] [--force]
                                  Bulk-dump the filtered archive: one file per
                                  transcript, <dir>/<YYYY-MM-DD>-<title-slug>-<id>
                                  .txt (exact 'text' rendering) or .json; skips
                                  files that already exist unless --force
  calendar [--view unimported|norec] [FILTERS except --speaker]
                                  Calendar-layer meetings that are NOT in the
                                  archive: unimported = a recording/transcript
                                  exists at Google/Microsoft but nobody imported
                                  it (default); norec = your past calendar
                                  events that left no artifacts at all
  audio <id> [--out <file>]       Download the recording (default ./<id>.<ext>)
  frame <id> <ts> [--out <file>]  Grab a video frame at a timestamp (ms, mm:ss or
                                  hh:mm:ss) as jpeg — only transcripts imported
                                  from a video recording have frames
  attachments <id>                List attached context files
  attachment-get <id> <attId> [--out <file>]   Download one attachment
  labels                          Org-wide label tree with visible-to-you counts
                                  (subtree-inclusive) and #ids; --json = flat rows
  series                          Recurring-call series you're in: id, title,
                                  cadence, members, auto-import + dup badges
  series <id>                     One series: config, evidence keys, members
                                  (imported transcripts), pending suggestions,
                                  probable duplicates
  notify                          Your Slack DM notification switches, one
                                  line per kind (opt-out: on unless turned off)

LABELS (org-wide, hierarchical 'Customers/LP Global/QBR', many per transcript;
<label> = a path, case-insensitive, or '#<id>' from 'labels')
  label <id> <label>              Add a label to a transcript — missing path
                                  segments are created (prints "created …")
  unlabel <id> <label>            Remove a label from a transcript
  list --label <label|none> [--exact]
                                  Filter the archive by label; default includes
                                  sub-labels, --exact = that label only, 'none'
                                  = unlabelled. Composes with the FILTERS below
  export --label <label|none> [--exact] --out-dir <dir>
                                  Mirror as folders: <dir>/<label path>/<date>
                                  <title> (<id>)/{meta.json,text.txt,notes.md,
                                  report.md}; a transcript carrying N matching
                                  labels lands N times (by design)
  label-create <path> [--color #rrggbb]
                                  Create a label (whole chain; 0 created = existed)
  label-rename <label> <newName>  Rename one segment (sub-label paths follow)
  label-mv <label> <newParent|/>  Move a label (and its subtree) under another
                                  label, or '/' = top level
  label-rm <label> [--cascade]    Delete a label; refuses (exit 1) if it has
                                  sub-labels unless --cascade. Assignments on
                                  meetings go with it

WRITE (needs read+write for meetings)
  import <meeting-code|event-key> [--mode transcript|video|both] [--wait]
                                  [--timeout <mins>]
                                  Import a meeting from your calendar by the
                                  [meeting-code] shown in 'calendar' (or an
                                  exact event key). Runs server-side under
                                  your backend Google link (Teams: app-only);
                                  not-ready artifacts queue automatically.
                                  Prints the transcript id + the stable
                                  /m/<uuid> link. --wait polls until the
                                  import completes (default cap 30 min)
  series set <id> [--title <t>] [--notes <md>] [--auto-import on|off]
             [--mode transcript|video|both] [--report summary|detailed-video|detailed-text|later]
                                  Rename / edit notes / configure auto-import
                                  (on = future occurrences import on their own
                                  under YOUR Google link)
  series merge <into-id> <from-id>   Fold a duplicate series into another
                                  (keys+members move, the loser is deleted,
                                  logged as you). Both must be visible to you
  series attach <id> <transcript-id> [--manual]   Attach a transcript you can
                                  access (absorbs its keys; default 'confirmed')
  series detach <id> <transcript-id> [--remember]   Detach; --remember = never
                                  re-suggest it for this series
  auto-sync                       Your account-level auto-sync switch + what it
                                  did recently (imports de-duplicated company-
                                  wide: one import per meeting, others shared in)
  auto-sync explain <meeting-code|uuid> [--start <iso>]
                                  What automation WILL do with one occurrence
                                  and what it DID: owner (series setting vs
                                  account auto-sync vs nobody + why), importer,
                                  mode, effective report (strongest ask across
                                  everyone in it), watchers, ledger row. The
                                  answer to "why wasn't this auto-imported /
                                  why only a summary". Start defaults to the
                                  latest past occurrence of that code
  auto-sync off|mine|all [--mode transcript|video|both]
             [--report summary|detailed-video|detailed-text|later]
             [--gmeet on|off] [--teams on|off]
                                  mine = meetings you organise, all = every
                                  meeting you attend (recommended: all, video,
                                  detailed-video — the defaults); only meetings
                                  that start after you switch it on. Needs
                                  Google connected
  notify <kind> on|off            Flip one Slack DM notification kind (see
                                  'notify' for the kinds)
  set-title <id> <title>          Update the title
  set-notes <id> --file <md|->    Replace the notes markdown ('-' = stdin)
  set-report <id> --file <md|->   Replace the report markdown ('-' = stdin)
  label / unlabel / label-create / label-rename / label-mv / label-rm
                                  (label/unlabel also need owner or edit access
                                  on that transcript; readers get 403)
  skill                           Print the agent workflow guide

ACCOUNT-SETTINGS writes ('auto-sync off|mine|all', 'notify <kind> on|off')
additionally require --i-have-got-consent-from-human-user: pass it ONLY when
the human user explicitly asked for that exact settings change — never on
your own initiative (same contract as the slack-* verbs).

FILTERS (list / search / export / calendar — all AND together; a comma
inside one value = OR; matching is case-insensitive substring)
  --participant <s>   organizer email, attendee emails + display names, and
                      (archive rows) speaker names. "@lp-global.com" = whole
                      domain, "nicolas" = a person. e.g. --participant a@x.com,b@y
  --organizer <s>     organizer email only
  --provider <p>      teams | gmeet | upload (comma = OR; 'upload' never matches
                      calendar rows). Anything else is rejected
  --speaker <s>       speaker names only (archive: list / search / export)
  --q <s>             text search, 2+ chars — list/export: title, filename,
                      description, notes, full text; calendar: title, organizer,
                      attendees. ('search' takes the query as its argument.)
  --from <YYYY-MM-DD> --to <YYYY-MM-DD>   inclusive day range in your timezone
                      (config 'timezone', else this machine's). Not on 'search'.
  --label <label|none> [--exact]   label filter (list / export only, see LABELS)
Tab counts / totals printed alongside already reflect the filters.
'list --json' / 'export' rows carry "participants": [emails] (organizer first)
and "labels": [{id,name,path,color}]; filtered 'list' lines show a
{path,path} column when a row has labels.

IDS: <id> is the transcript id shown by 'list' (also in web URLs:
/transcript/<id>). Timestamps in 'text' output are utterance starts — feed
them to 'frame' to see what was on screen at that moment. 'calendar' rows
show [meeting-code] — feed it to 'import' to import the occurrence from
here (server-side, your backend Google link; Teams runs app-only).

If the server is unreachable, the user is probably off the company VPN/
tailnet — say so and wait; don't retry-loop.

Per-subcommand --help is not a thing — this page is the whole reference.
`;

const SKILL = `# darth meetings — agent workflow guide

This CLI deliberately has NO AI commands. You (the agent reading this) are
the intelligence; the CLI gives you deterministic primitives. You spend your
own tokens, then write results back so humans see them in the web UI.

## The core loop: summarize / analyze a meeting

    darth-cli meetings list --json          # find the transcript id
    darth-cli meetings text <id>            # full transcript, speaker-named
    # ...you read/analyze/summarize with YOUR model...
    darth-cli meetings set-notes <id> --file summary.md    # write it back

set-notes/set-report replace the markdown shown in the web UI's Summary /
Report tabs and are logged as "updated notes via darth-cli" in the activity
feed. Notes = quick summary tier; report = detailed wiki-style tier.

## Grounding in what was on screen

Transcripts imported from a video recording can serve frames:

    darth-cli meetings frame <id> 12:34 --out slide.jpg

Grab frames at moments the transcript flags ("as you can see here…", screen
shares, demos) and read the image yourself. Frames are extracted server-side
with ffmpeg and cached — first hit costs a keyframe seek, later hits are
file reads. A 404 means that transcript has no video.

## Searching & filtering

'search <query>' is a server-side deep search (ILIKE; --regex switches the
query to a case-insensitive POSIX regex — alternation, \m..\M word
boundaries, quantifiers all work) across titles,
filenames, descriptions, notes and full transcript text — use it to FIND
meetings. For regex/precise analysis, fetch 'text <id>' and grep locally.

People/provider filters work the same on list / search / export / calendar:

    darth-cli meetings list --participant @lp-global.com --provider teams
    darth-cli meetings list --organizer swaralee --from 2026-07-01 --to 2026-08-31
    darth-cli meetings search pricing --participant nicolas
    darth-cli meetings calendar --view norec --participant @lp-global.com

"Everything this customer said over the last quarter" is one command:

    darth-cli meetings export --participant @lp-global.com \\
        --from 2026-05-01 --to 2026-07-31 --out-dir ./lp-global-q2

→ one <date>-<title>-<id>.txt per meeting (same rendering as 'text'), then
read/grep/analyze the folder with your own model. Re-running only fetches
files that are missing (--force rewrites). --format json gives structured
lines ({ms, speaker, text}) plus the row metadata instead.

'calendar' lists meetings that are NOT in the archive yet (recording exists
at Google/Microsoft but un-imported, or no recording at all) — use it to
tell a human "these 3 meetings have recordings nobody imported"; importing
itself is a web-UI action.

## Labels (org-wide taxonomy, many per meeting)

Labels are hierarchical paths ('Customers/LP Global/QBR') shared by the
whole org — everyone sees the same tree, counts are "visible to you". A
meeting can carry any number of labels; filtering by a label includes its
sub-labels unless --exact. Deterministic verbs, no AI:

    darth-cli meetings labels                       # tree + counts + #ids
    darth-cli meetings label <id> Customers/LP Global   # creates missing segments
    darth-cli meetings unlabel <id> '#12'
    darth-cli meetings list --label customers --from 2026-07-01   # case-insensitive
    darth-cli meetings list --label none            # unlabelled meetings
    darth-cli meetings export --label Customers --out-dir ./mirror

The export mirror is a folder tree <dir>/<label path>/<date> <title> (<id>)/
with meta.json, text.txt (= 'text <id>'), notes.md and report.md (the
latter two only when they exist) — read a whole customer's history with
your own model in one walk. Paths you type are case-insensitive; '#<id>'
from 'labels' works wherever a label is expected. Before inventing a new
top-level label, run 'labels' and reuse an existing branch — it is a shared
taxonomy, not a personal tag list. label-rename / label-mv / label-rm
change it for everyone (the server logs who did it).

## Report markdown conventions

The web UI's report tab renders two special link protocols:
  [12:34](t:754000)          jump-to-timestamp link (ms)
  ![slide](frame:754000)     embedded video frame at that ms
Use them in set-report markdown to produce rich, clickable reports.

## Etiquette

- Anything you post unattended on a human's behalf should be identifiable
  as agent-written (e.g. a trailing "— summarized by <agent>" line).
- set-notes/set-report REPLACE content. Read the existing markdown first
  ('notes <id>') if the human may have curated it.
- Write commands need a read+write token for meetings; on a 403, tell your
  human to re-run 'darth-cli login' and pick Read + write.
`;

/** "754000" | "12:34" | "1:02:03" → milliseconds. */
function parseTs(raw: string): number | null {
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  const [, h, mm, ss] = m;
  return ((h ? parseInt(h, 10) : 0) * 3600 + parseInt(mm!, 10) * 60 + parseInt(ss!, 10)) * 1000;
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  return fmtMs(seconds * 1000);
}

const EXT_BY_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/wav": "wav",
  "audio/x-wav": "wav", "audio/webm": "webm", "video/mp4": "mp4", "video/webm": "webm",
  "application/octet-stream": "bin",
};

async function download(ctx: Ctx, path: string, outFile: string | undefined, fallbackName: string): Promise<number> {
  const res = await ctx.api("meetings", path);
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error || msg; } catch {}
    console.error(`Error (HTTP ${res.status}): ${msg}`);
    return 1;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const type = (res.headers.get("content-type") || "").split(";")[0]!.trim();
  const out = outFile || `${fallbackName}.${EXT_BY_TYPE[type] || "bin"}`;
  writeFileSync(out, buf);
  console.log(`${out}  (${buf.length} bytes, ${type || "unknown type"})`);
  return 0;
}

function readMarkdownFlag(fileFlag: string | undefined): string | null {
  if (!fileFlag) return null;
  try {
    return fileFlag === "-" ? readFileSync(0, "utf8") : readFileSync(fileFlag, "utf8");
  } catch (e: any) {
    console.error(`--file: ${e?.message || e}`);
    return null;
  }
}

/** Web-app base for printable links — same host the meetings API lives on. */
function webBase(ctx: Ctx): string {
  return (ctx.config.meetingsUrl || "https://meetings.darth-internal.trames.io").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Shared filter flags (list / search / export / calendar)
// ---------------------------------------------------------------------------

/** Server-side filter params — names are the API contract of
 * GET /api/transcripts?v=2, /api/transcripts/search, /api/calendar-meetings. */
const PEOPLE_FLAGS = ["participant", "organizer", "provider", "speaker"] as const;
const RANGE_FLAGS = ["from", "to"] as const;
const ALL_FILTER_FLAGS = [...PEOPLE_FLAGS, ...RANGE_FLAGS, "q"] as const;
const PROVIDERS = ["teams", "gmeet", "upload"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type FilterRead =
  | { ok: true; params: URLSearchParams; active: boolean }
  | { ok: false; error: string };

/** Display/range timezone: config 'timezone', else this machine's. */
function localTz(ctx: Ctx): string {
  return ctx.config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Read the shared filter flags into query params. `allow` lists which flags
 * this command forwards; any other filter flag present is an error (never
 * silently ignored — the server would drop e.g. --speaker on calendar views).
 * Values are passed through verbatim (comma = OR is server-side semantics);
 * only cheap shape checks happen here so typos fail before a network hop.
 */
/**
 * `--cascade` / `--exact` are booleans, but the shared parseArgs eats the next
 * non-`--` token as a flag VALUE (`label-rm --cascade zz-test` →
 * cascade='zz-test', no label). Normalise: 1/true/yes → true, 0/false/no →
 * false, anything else was a swallowed positional → hand it back to `pos`
 * and set the flag true.
 */
const CONSENT_FLAG = "i-have-got-consent-from-human-user";

/** Account-settings writes (auto-sync, notify) change how the service
 * behaves for the human LONG after this session — an agent must never flip
 * them on its own initiative. Same contract as darth-cli's slack-* verbs. */
function requireConsent(flags: Record<string, string | boolean>, what: string): boolean {
  if (flags[CONSENT_FLAG] === true) return true;
  console.error(
    `Changing ${what} is an account-settings write. Re-run with --${CONSENT_FLAG}\n` +
      `ONLY if the human user explicitly asked for this exact change.`
  );
  return false;
}

function liftBoolFlags(pos: string[], flags: Record<string, string | boolean>, names: readonly string[]): void {
  for (const name of names) {
    const v = flags[name];
    if (v === undefined || typeof v === "boolean") continue;
    const lc = v.trim().toLowerCase();
    if (["1", "true", "yes"].includes(lc)) flags[name] = true;
    else if (["0", "false", "no"].includes(lc)) delete flags[name];
    else { flags[name] = true; pos.push(v); }
  }
}

function readFilterFlags(ctx: Ctx, flags: Record<string, string | boolean>, allow: readonly string[]): FilterRead {
  const params = new URLSearchParams();
  let active = false;
  // --label/--exact are resolved separately (async, needs GET /api/labels —
  // see resolveLabelFilter); here we only reject them where unsupported so
  // `calendar --label x` fails loudly instead of silently listing everything.
  for (const name of ["label", "exact"] as const) {
    if (flags[name] !== undefined && !allow.includes(name)) return { ok: false, error: `--${name} is not supported by this command` };
  }
  if (flags.exact !== undefined && flags.label === undefined) return { ok: false, error: "--exact only makes sense together with --label" };
  for (const name of ALL_FILTER_FLAGS) {
    const v = flags[name];
    if (v === undefined) continue;
    if (!allow.includes(name)) return { ok: false, error: `--${name} is not supported by this command` };
    if (typeof v !== "string" || !v.trim()) return { ok: false, error: `--${name} needs a value` };
    const val = v.trim();
    if (name === "provider") {
      const bad = val.split(",").map(x => x.trim().toLowerCase()).filter(x => x && !PROVIDERS.includes(x));
      if (bad.length) return { ok: false, error: `--provider: unknown value(s) ${bad.join(", ")} — use ${PROVIDERS.join("|")} (comma = OR)` };
    }
    if ((name === "from" || name === "to") && !DAY_RE.test(val))
      return { ok: false, error: `--${name} must be YYYY-MM-DD` };
    if (name === "q" && val.length < 2) return { ok: false, error: "--q needs 2+ chars" };
    params.set(name, val);
    active = true;
  }
  if (params.has("from") || params.has("to")) params.set("tz", localTz(ctx));
  return { ok: true, params, active };
}

/**
 * Drain a day-bucketed, cursor-paged listing (listing v2 and calendar views
 * share the envelope: {days:[{key,rows}], counts, nextCursor, hasMore}).
 * Asks for the fattest pages the server allows and follows nextCursor until
 * exhausted, so callers see ONE flat row list regardless of size.
 */
async function drainDayPages<R = any, C = any>(
  ctx: Ctx, path: string, base: URLSearchParams,
): Promise<{ rows: R[]; counts: C }> {
  const rows: R[] = [];
  let counts: C = {} as C;
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 500; page++) {
    const q = new URLSearchParams(base);
    q.set("days", "60");
    q.set("minRows", "200");
    if (!q.has("tz")) q.set("tz", localTz(ctx));
    if (cursor) q.set("cursor", cursor);
    const data = await ctx.expectJson<{ days: Array<{ key: string; rows: R[] }>; counts: C; nextCursor: string | null; hasMore: boolean }>(
      ctx.api("meetings", `${path}${path.includes("?") ? "&" : "?"}${q.toString()}`));
    if (page === 0) counts = data.counts;
    for (const d of data.days || []) rows.push(...(d.rows || []));
    if (!data.hasMore || !data.nextCursor || seen.has(data.nextCursor)) break;
    seen.add(data.nextCursor);
    cursor = data.nextCursor;
  }
  return { rows, counts };
}

// ---------------------------------------------------------------------------
// Labels (org-wide hierarchical taxonomy — docs/labels-design.md §6)
// ---------------------------------------------------------------------------
// The path helpers below mirror src/lib/labels.ts (pure) — this folder is
// copied into darth-cli at build time, so it cannot import from the app.

/** Minimal label as carried on listing rows / assignment responses. */
interface LabelRef { id: number; name: string; path: string; color: string | null }
/** Flat row of GET /api/labels (sorted by path_key by the server). */
interface LabelRow extends LabelRef {
  parent_id: number | null; depth: number; path_key: string; description: string | null;
  created_by_email: string; count_visible?: number; count_direct?: number;
}

/** 'a / b//c ' → ['a','b','c'] (trim segments, drop empties). */
function splitLabelPath(input: string): string[] {
  return input.split("/").map(s => s.trim()).filter(Boolean);
}
/** Case-folded comparison key, same folding as the server's path_key. */
function labelPathKey(input: string): string {
  return splitLabelPath(input).join("/").toLowerCase();
}
/** '#12' → 12; anything else → null. */
function labelIdArg(input: string): number | null {
  const m = /^#(\d+)$/.exec(input.trim());
  return m ? parseInt(m[1]!, 10) : null;
}
/** Filesystem-safe folder segment that still reads like the label / title:
 * keeps case and inner spaces, swaps path separators + Windows-illegal chars
 * for '-', strips control chars and trailing dots/spaces, caps length. */
function fsSegment(raw: string, max = 120): string {
  let s = (raw ?? "").replace(/[\x00-\x1f\x7f]/g, "").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  if (s.length > max) s = s.slice(0, max).replace(/[. ]+$/g, "");
  return !s || s === "." || s === ".." ? "_" : s;
}
/** Does `pathKey` sit at / under the label `rootKey`? */
function underLabel(pathKey: string, rootKey: string, exact: boolean): boolean {
  return pathKey === rootKey || (!exact && pathKey.startsWith(rootKey + "/"));
}

/**
 * Export-mirror folder path per label id. Siblings whose names differ only in
 * characters fsSegment folds away ('Q&A: 2026' vs 'Q&A- 2026') would land in
 * one directory — those get a ' (#id)' suffix so every label keeps its own
 * folder. Unknown ids (label not in the catalog) fall back to the display
 * path segments.
 */
function exportRelPaths(rows: LabelRow[]): Map<number, string> {
  const byId = new Map(rows.map(r => [r.id, r]));
  const segOf = new Map<number, string>();
  const groups = new Map<string, LabelRow[]>();
  for (const r of rows) {
    const k = `${r.parent_id ?? 0}|${fsSegment(r.name)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  for (const list of groups.values()) {
    for (const r of list) segOf.set(r.id, list.length > 1 ? `${fsSegment(r.name)} (#${r.id})` : fsSegment(r.name));
  }
  const out = new Map<number, string>();
  const rel = (id: number, guard = 0): string => {
    const cached = out.get(id);
    if (cached !== undefined) return cached;
    const r = byId.get(id);
    if (!r || guard > 8) return "";
    const own = segOf.get(id) ?? fsSegment(r.name);
    const parent = r.parent_id == null ? "" : rel(r.parent_id, guard + 1);
    const v = parent ? `${parent}/${own}` : own;
    out.set(id, v);
    return v;
  };
  for (const r of rows) rel(r.id);
  return out;
}

async function fetchLabels(ctx: Ctx, counts = false): Promise<LabelRow[]> {
  const data = await ctx.expectJson<{ labels: LabelRow[] }>(ctx.api("meetings", `/api/labels${counts ? "?counts=1" : ""}`));
  return data.labels || [];
}

/**
 * Resolve a user-typed `<label>` ('Customers/LP Global', case-insensitive,
 * or '#12') against the org tree. `rows` is the GET /api/labels listing
 * (pass it in when you already have it — one fetch per run is plenty).
 */
async function resolveLabel(ctx: Ctx, input: string, rows?: LabelRow[]): Promise<{ rows: LabelRow[]; label: LabelRow | null; key: string }> {
  const all = rows ?? await fetchLabels(ctx);
  const id = labelIdArg(input);
  if (id !== null) return { rows: all, label: all.find(l => l.id === id) ?? null, key: `#${id}` };
  const key = labelPathKey(input);
  return { rows: all, label: key ? all.find(l => l.path_key === key) ?? null : null, key };
}

/** Resolve or exit 1 with a helpful message (mutations / filters need an existing label). */
async function requireLabel(ctx: Ctx, input: string, rows?: LabelRow[]): Promise<{ rows: LabelRow[]; label: LabelRow }> {
  const r = await resolveLabel(ctx, input, rows);
  if (r.label) return { rows: r.rows, label: r.label };
  if (!r.key) { console.error("label path is empty — e.g. Customers/LP Global or '#12'"); process.exit(1); }
  const near = r.rows.filter(l => l.path_key.includes(r.key.replace(/^#/, "").toLowerCase())).slice(0, 5).map(l => `  ${l.path}  (#${l.id})`);
  console.error(`No label '${input}'.${near.length ? `\nDid you mean:\n${near.join("\n")}` : " Run 'darth-cli meetings labels' to see the tree."}`);
  process.exit(1);
}

/** --label/--exact → the listing-v2 `label=<id|none>&exact=1` params (spec §7). */
async function resolveLabelFilter(ctx: Ctx, flags: Record<string, string | boolean>, params: URLSearchParams):
  Promise<{ active: boolean; root: LabelRow | null; none: boolean; exact: boolean; rows: LabelRow[] }> {
  const raw = flags.label;
  if (raw === undefined) return { active: false, root: null, none: false, exact: false, rows: [] };
  if (typeof raw !== "string" || !raw.trim()) { console.error("--label needs a value: a path, '#<id>' or none"); process.exit(1); }
  const exact = flags.exact === true;
  if (raw.trim().toLowerCase() === "none") {
    params.set("label", "none");
    return { active: true, root: null, none: true, exact, rows: [] };
  }
  const { label, rows } = await requireLabel(ctx, raw);
  params.set("label", String(label.id));
  if (exact) params.set("exact", "1");
  return { active: true, root: label, none: false, exact, rows };
}

/** Indented tree of the flat listing ("Customers (41) #3" → children by parent_id). */
function printLabelTree(rows: LabelRow[]): void {
  if (!rows.length) return console.log("No labels yet — create one: darth-cli meetings label-create <path>   (or: label <id> <path>)");
  const byParent = new Map<number | null, LabelRow[]>();
  for (const l of rows) {
    const k = l.parent_id != null && rows.some(p => p.id === l.parent_id) ? l.parent_id : null;
    (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(l);
  }
  const width = Math.min(48, Math.max(12, ...rows.map(l => (l.depth - 1) * 2 + l.name.length)));
  const countOf = (l: LabelRow) => {
    const vis = l.count_visible ?? 0, direct = l.count_direct ?? vis;
    return direct !== vis ? `(${vis} · ${direct} direct)` : `(${vis})`;
  };
  const cwidth = Math.max(...rows.map(l => countOf(l).length));
  const walk = (parent: number | null, depth: number) => {
    const kids = (byParent.get(parent) ?? []).sort((a, b) => a.path_key < b.path_key ? -1 : a.path_key > b.path_key ? 1 : a.id - b.id);
    for (const l of kids) {
      console.log(`${"  ".repeat(depth)}${l.name.padEnd(Math.max(0, width - depth * 2))}  ${countOf(l).padStart(cwidth)}  #${l.id}${l.color ? `  ${l.color}` : ""}`);
      walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  const total = rows.length, top = (byParent.get(null) ?? []).length;
  console.log(`\n${total} label(s), ${top} top-level · counts = meetings visible to you, sub-labels included · '#id' works wherever a <label> is expected`);
}

/** Response of the assignment routes → one human line. */
function printAssigned(id: string, labels: LabelRef[]): void {
  console.log(`${id}: ${labels.length ? labels.map(l => l.path).join(", ") : "(no labels)"}`);
}

/** One archive row → the 'list' line (legacy and filtered paths share it). */
function transcriptDate(t: any): string {
  return (t.recorded_at || t.completed_at || t.created_at || "").slice(0, 10);
}

function printTranscriptRows(rows: any[]): void {
  for (const t of rows) {
    const date = transcriptDate(t);
    const title = t.title || t.original_filename || "(untitled)";
    const flagsCol = [
      t.status !== "completed" ? t.status : null,
      t.access !== "owner" ? t.access : null,
      t.auto_notes ? "notes" : null,
      t.auto_report ? "report" : null,
    ].filter(Boolean).join(",");
    // Labels column only exists on listing-v2 rows; legacy rows never have
    // the field, so the no-flag `list` output stays byte-identical.
    const labelsCol = Array.isArray(t.labels) && t.labels.length ? `  {${t.labels.map((l: LabelRef) => l.path).join(",")}}` : "";
    console.log(`${t.assemblyai_id}  ${date}  ${fmtDuration(t.duration).padStart(7)}  ${String(t.speaker_count ?? "?").padStart(2)}sp  ${title}${labelsCol}${flagsCol ? `  [${flagsCol}]` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Transcript text rendering (shared by 'text' and 'export')
// ---------------------------------------------------------------------------

interface TranscriptText {
  /** Exactly what 'text <id>' prints (no trailing newline). */
  text: string;
  /** Speaker-named utterances; empty when the transcript has no diarization. */
  lines: Array<{ ms: number; ts: string; speaker: string; text: string }>;
}

/**
 * Fetch content + confirmed speaker names and render "[mm:ss] Name: …".
 * `getJson` decides the failure policy: ctx.expectJson exits the process
 * (fine for 'text'), export passes a throwing variant so one bad transcript
 * doesn't abort the whole dump.
 */
async function fetchTranscriptText(ctx: Ctx, id: string, getJson: (path: string) => Promise<any>): Promise<TranscriptText> {
  const [contentRes, speakers] = await Promise.all([
    getJson(`/api/transcripts/${id}/content`),
    getJson(`/api/transcripts/${id}/speakers`) as Promise<{ speakerLabels: Array<{ originalSpeaker: string; customName: string }> }>,
  ]);
  const content = contentRes.content ?? contentRes;
  const names = new Map((speakers.speakerLabels || []).map(l => [l.originalSpeaker, l.customName]));
  const utterances: any[] = content.utterances || [];
  if (!utterances.length) {
    // no diarization — fall back to the flat text
    return { text: content.text || "(empty transcript)", lines: [] };
  }
  const lines = utterances.map(u => ({
    ms: u.start as number, ts: fmtMs(u.start), speaker: names.get(u.speaker) || `Speaker ${u.speaker}`, text: u.text as string,
  }));
  return { text: lines.map(l => `[${l.ts}] ${l.speaker}: ${l.text}`).join("\n"), lines };
}

/** "LP-Global<>Trames Weekly Catch Up" → "lp-global-trames-weekly-catch-up" */
function slugify(raw: string): string {
  const s = raw.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s || "untitled";
}

/** Soft JSON fetch for bulk loops: throws (instead of exiting) on failure. */
async function getJsonOrThrow(ctx: Ctx, path: string): Promise<any> {
  const res = await ctx.api("meetings", path);
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data?.error || text.slice(0, 200)}`);
  if (data === null) throw new Error(`non-JSON response: ${text.slice(0, 120)}`);
  return data;
}

// ---------------------------------------------------------------------------
// Calendar-layer rows
// ---------------------------------------------------------------------------

function fmtLocalDateTime(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

/** What evidence the provider holds for a calendar row, and whether the web
 * UI's import flow could act on it (mirrors calendar-meeting-rows.tsx). */
function calendarEvidence(r: any): { evidence: string; importable: boolean } {
  if (r.hasRecording) return { evidence: r.recordingCount > 1 ? `recording x${r.recordingCount}` : "recording", importable: true };
  if (r.hasTranscript) {
    if (r.transcriptParseable === false) return { evidence: "transcript (unparseable)", importable: false };
    return { evidence: r.geminiNotes ? "gemini-notes" : "transcript", importable: true };
  }
  if (r.recordingPreparing || r.transcriptPreparing) return { evidence: "preparing", importable: false };
  return { evidence: r.hasMeet === false && !r.meetingCode ? "no-meet-link" : "none", importable: false };
}

const meetings: Subcommand = {
  name: "meetings",
  summary: "Meeting transcripts, notes & recordings (darth-meetings)",
  help: HELP,
  async run(ctx, argv) {
    const { pos, flags } = parseArgs(argv);
    liftBoolFlags(pos, flags, ["cascade", "exact", CONSENT_FLAG]);
    const [, cmd, ...args] = pos.length && pos[0] === "meetings" ? pos : ["", ...pos];
    if (!cmd || flags.help === true) { console.log(HELP); return 0; }

    switch (cmd) {
      case "skill": {
        console.log(SKILL);
        return 0;
      }

      case "auto-sync": {
        const sub = args[0];
        const fmtRow = (a: any) =>
          `${(a.occStart ?? "").slice(0, 10).padEnd(11)}${String(a.outcome).padEnd(10)} ${a.title ?? a.occKey}` +
          (a.importerEmail && !a.mine ? `  (via ${a.importerEmail})` : "") +
          (a.assemblyaiId ? `  ${a.assemblyaiId}` : "") +
          (a.detail && a.outcome !== "imported" && a.outcome !== "deferred" ? `  — ${a.detail}` : "");
        if (!sub) {
          const data = await ctx.expectJson<any>(ctx.api("meetings", "/api/auto-sync"));
          ctx.print(data, () => {
            const s = data.autoSync;
            console.log(`auto-sync: ${s.scope}${s.scope !== "off" ? `  (mode ${s.mode}, report ${s.report}, gmeet ${s.providers.gmeet ? "on" : "off"}, teams ${s.providers.teams ? "on" : "off"}, since ${s.since ?? "?"})` : ""}`);
            if (!data.googleConnected) console.log("google: NOT connected — connect in the web app Settings before turning this on");
            if (data.activity?.length) {
              console.log("\nrecent:");
              for (const a of data.activity) console.log("  " + fmtRow(a));
            }
          });
          return 0;
        }
        if (sub === "explain") {
          const ref = args[1];
          if (!ref) { console.error("usage: darth-cli meetings auto-sync explain <meeting-code|uuid> [--start <iso>]"); return 1; }
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
          const q = new URLSearchParams(isUuid ? { uuid: ref } : { code: ref });
          const start = str(flags.start);
          if (start) q.set("start", start);
          const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/auto-sync/plan?${q}`));
          ctx.print(data, () => {
            const o = data.occurrence; const p = data.plan; const l = data.ledger;
            console.log(`${o.title ?? o.code}  ${o.startIso}  (${o.provider}, organiser ${o.organizerEmail ?? "?"}, ${o.attendees.length} attendee(s), in ${o.knownToCalendars} calendar cache(s))`);
            console.log(`owner:    ${p.owner}${p.seriesTitle ? `  series "${p.seriesTitle}" (#${p.seriesId}${p.seriesOptedOut ? ", OPTED OUT" : ""})` : ""}`);
            console.log(`why:      ${p.reason}`);
            if (p.importer) console.log(`importer: ${p.importer.email}${p.fallbackImporters?.length ? `  (fallbacks: ${p.fallbackImporters.map((f: any) => f.email).join(", ")})` : ""}`);
            if (p.mode) console.log(`mode:     ${p.mode}`);
            if (p.report) console.log(`report:   ${p.report}  (strongest ask across everyone served)`);
            if (p.watchers?.length) console.log(`watchers: ${p.watchers.join(", ")}`);
            if (p.interested?.length) {
              console.log("interested (own auto-sync covers it):");
              for (const i of p.interested) console.log(`  ${i.email.padEnd(40)} ${i.mode.padEnd(10)} ${i.report}${i.organiser ? "  organiser" : ""}`);
            }
            if (l) console.log(`ledger:   ${l.kind} → ${l.outcome}${l.importerEmail ? ` by ${l.importerEmail}` : ""}${l.seriesTitle ? ` (series "${l.seriesTitle}")` : ""}${l.assemblyaiId ? `  ${l.assemblyaiId}` : ""}${l.detail ? `  — ${l.detail}` : ""}  at ${l.at}`);
            else console.log("ledger:   nothing fired yet");
          });
          return 0;
        }
        ctx.requireWrite();
        if (!["off", "mine", "all"].includes(sub)) { console.error("usage: darth-cli meetings auto-sync [explain <ref>] [off|mine|all] [--mode ...] [--report ...] [--gmeet on|off] [--teams on|off]"); return 1; }
        if (!requireConsent(flags, "account auto-sync")) return 1;
        const body: any = { scope: sub };
        const mode = str(flags.mode); const report = str(flags.report);
        if (mode) body.mode = mode;
        if (report) body.report = report;
        const gm = str(flags.gmeet); const tm = str(flags.teams);
        if (gm !== undefined || tm !== undefined) {
          body.providers = {};
          if (gm !== undefined) body.providers.gmeet = gm === "on";
          if (tm !== undefined) body.providers.teams = tm === "on";
        }
        const data = await ctx.expectJson<any>(ctx.api("meetings", "/api/auto-sync", { method: "PUT", body: JSON.stringify(body) }));
        ctx.print(data, () => console.log(`auto-sync: ${data.autoSync.scope}${data.autoSync.scope !== "off" ? ` (mode ${data.autoSync.mode}, report ${data.autoSync.report}, since ${data.autoSync.since})` : ""}`));
        return 0;
      }

      case "notify": {
        const sub = args[0];
        if (!sub) {
          const data = await ctx.expectJson<any>(ctx.api("meetings", "/api/notify-prefs"));
          ctx.print(data, () => {
            console.log("Slack DM notifications (opt-out — every kind is on unless turned off):");
            for (const k of data.kinds as string[]) {
              const l = data.labels?.[k];
              console.log(
                `  ${(data.prefs?.[k] === false ? "OFF" : "on").padEnd(4)}${k.padEnd(17)}${l?.label ?? ""}${l?.hint ? ` — ${l.hint}` : ""}`
              );
            }
          });
          return 0;
        }
        ctx.requireWrite();
        const val = args[1];
        const current = await ctx.expectJson<any>(ctx.api("meetings", "/api/notify-prefs"));
        const kinds: string[] = current.kinds ?? [];
        if (!kinds.includes(sub) || !["on", "off"].includes(val ?? "")) {
          console.error(`usage: darth-cli meetings notify [<kind> on|off]   kinds: ${kinds.join(", ")}`);
          return 1;
        }
        if (!requireConsent(flags, `the '${sub}' notification setting`)) return 1;
        const data = await ctx.expectJson<any>(
          ctx.api("meetings", "/api/notify-prefs", {
            method: "PUT",
            body: JSON.stringify({ prefs: { [sub]: val === "on" } }),
          })
        );
        ctx.print(data, () => console.log(`${sub}: ${data.prefs?.[sub] === false ? "off" : "on"}`));
        return 0;
      }

      case "whoami": {
        const data = await ctx.expectJson<any>(ctx.api("meetings", "/api/whoami"));
        ctx.print(data, () =>
          console.log(`${data.email} (${data.userId}) via ${data.via}${data.scope ? `, meetings scope: ${data.scope}` : ""}`));
        return 0;
      }

      case "list": {
        const fr = readFilterFlags(ctx, flags, [...ALL_FILTER_FLAGS, "label", "exact"]);
        if (!fr.ok) { console.error(fr.error); return 1; }
        const lf = await resolveLabelFilter(ctx, flags, fr.params);
        if (!fr.active && !lf.active) {
          // No filters → the legacy full listing, byte-for-byte as before.
          const data = await ctx.expectJson<{ transcripts: any[] }>(ctx.api("meetings", "/api/transcripts"));
          const rows = data.transcripts;
          ctx.print(rows, () => {
            if (!rows.length) return console.log("No transcripts visible to you yet.");
            printTranscriptRows(rows);
            console.log(`\n${rows.length} transcript(s)`);
          });
          return 0;
        }
        // Filters → listing v2 (server-side filter + day-bucket pages), drained.
        const { rows, counts } = await drainDayPages<any, { all: number; mine: number; shared: number }>(
          ctx, "/api/transcripts?v=2&tab=all", fr.params);
        ctx.print(rows, () => {
          if (!rows.length) return console.log("No transcripts match those filters.");
          printTranscriptRows(rows);
          const labelNote = lf.none ? " · unlabelled only" : lf.root ? ` · label ${lf.root.path}${lf.exact ? " (exact)" : " (+ sub-labels)"}` : "";
          console.log(`\n${rows.length} transcript(s) matching — ${counts.mine ?? "?"} yours, ${counts.shared ?? "?"} shared with you${labelNote}`);
        });
        return 0;
      }

      case "labels": {
        const rows = await fetchLabels(ctx, true);
        ctx.print(rows, () => printLabelTree(rows));
        return 0;
      }

      case "label":
      case "unlabel": {
        const id = args[0];
        const target = args.slice(1).join(" ").trim();
        if (!id || !target) { console.error(`usage: darth-cli meetings ${cmd} <id> <label path|#id>`); return 1; }
        ctx.requireWrite();
        if (cmd === "unlabel") {
          const { label } = await requireLabel(ctx, target);
          const data = await ctx.expectJson<{ labels: LabelRef[] }>(ctx.api("meetings", `/api/transcripts/${id}/labels/${label.id}`, { method: "DELETE" }));
          ctx.print(data, () => { console.log(`removed ${label.path} (#${label.id})`); printAssigned(id, data.labels || []); });
          return 0;
        }
        // label: resolve first so we can say exactly which segments were created.
        const r = await resolveLabel(ctx, target);
        let label = r.label;
        let created: LabelRef[] = [];
        if (!label) {
          if (labelIdArg(target) !== null) { console.error(`No label ${target}. Run 'darth-cli meetings labels'.`); return 1; }
          const made = await ctx.expectJson<{ label: LabelRow; created: LabelRef[] }>(
            ctx.api("meetings", "/api/labels", { method: "POST", body: JSON.stringify({ path: splitLabelPath(target).join("/") }) }));
          label = made.label; created = made.created || [];
        }
        const data = await ctx.expectJson<{ labels: LabelRef[] }>(
          ctx.api("meetings", `/api/transcripts/${id}/labels`, { method: "POST", body: JSON.stringify({ labelId: label.id }) }));
        ctx.print({ ...data, label, created }, () => {
          for (const c of created) console.log(`created ${c.path} (#${c.id})`);
          console.log(`added ${label!.path} (#${label!.id})`);
          printAssigned(id, data.labels || []);
        });
        return 0;
      }

      case "label-create": {
        const path = args.join(" ").trim();
        if (!splitLabelPath(path).length) { console.error("usage: darth-cli meetings label-create <path>   (e.g. Customers/LP\\ Global)"); return 1; }
        ctx.requireWrite();
        const color = str(flags.color);
        const made = await ctx.expectJson<{ label: LabelRow; created: LabelRef[] }>(
          ctx.api("meetings", "/api/labels", { method: "POST", body: JSON.stringify({ path: splitLabelPath(path).join("/"), ...(color ? { color } : {}) }) }));
        ctx.print(made, () => {
          for (const c of made.created || []) console.log(`created ${c.path} (#${c.id})`);
          if (!(made.created || []).length) console.log(`exists ${made.label.path} (#${made.label.id}) — nothing created`);
          else console.log(`${made.label.path} (#${made.label.id}) ready`);
        });
        return 0;
      }

      case "label-rename": {
        const [target, newName] = args;
        if (!target || !newName || args.length > 2) { console.error("usage: darth-cli meetings label-rename <label path|#id> <newName>   (quote values with spaces)"); return 1; }
        if (newName.includes("/")) { console.error("newName is one segment — no '/'. To move a label use label-mv."); return 1; }
        ctx.requireWrite();
        const { label } = await requireLabel(ctx, target);
        const data = await ctx.expectJson<{ label: LabelRow; updated: Array<{ id: number; path: string }> }>(
          ctx.api("meetings", `/api/labels/${label.id}`, { method: "PATCH", body: JSON.stringify({ name: newName.trim() }) }));
        ctx.print(data, () => {
          console.log(`renamed ${label.path} → ${data.label.path} (#${label.id})`);
          for (const u of data.updated || []) if (u.id !== label.id) console.log(`  sub-label #${u.id} → ${u.path}`);
        });
        return 0;
      }

      case "label-mv": {
        const [target, dest] = args;
        if (!target || !dest || args.length > 2) { console.error("usage: darth-cli meetings label-mv <label path|#id> <new parent path|#id|/>   (quote values with spaces)"); return 1; }
        ctx.requireWrite();
        const { rows, label } = await requireLabel(ctx, target);
        let parentId: number | null = null;
        if (dest.trim() !== "/") parentId = (await requireLabel(ctx, dest, rows)).label.id;
        if (parentId === label.parent_id) { console.log(`${label.path} (#${label.id}) is already there — nothing to do`); return 0; }
        const data = await ctx.expectJson<{ label: LabelRow; updated: Array<{ id: number; path: string }> }>(
          ctx.api("meetings", `/api/labels/${label.id}`, { method: "PATCH", body: JSON.stringify({ parentId }) }));
        ctx.print(data, () => {
          console.log(`moved ${label.path} → ${data.label.path} (#${label.id})`);
          for (const u of data.updated || []) if (u.id !== label.id) console.log(`  sub-label #${u.id} → ${u.path}`);
        });
        return 0;
      }

      case "label-rm": {
        const target = args.join(" ").trim();
        if (!target) { console.error("usage: darth-cli meetings label-rm <label path|#id> [--cascade]"); return 1; }
        ctx.requireWrite();
        const { rows, label } = await requireLabel(ctx, target);
        const kids = rows.filter(l => l.path_key.startsWith(label.path_key + "/")).length;
        const cascade = flags.cascade === true;
        if (kids && !cascade) {
          console.error(`${label.path} (#${label.id}) has ${kids} sub-label(s) — re-run with --cascade to delete the whole subtree (their assignments go too).`);
          return 1;
        }
        const data = await ctx.expectJson<{ ok: boolean; removedAssignments: number; removedLabels: number }>(
          ctx.api("meetings", `/api/labels/${label.id}${cascade ? "?cascade=1" : ""}`, { method: "DELETE" }));
        ctx.print(data, () =>
          console.log(`deleted ${label.path} (#${label.id}) — ${data.removedLabels ?? 1} label(s), ${data.removedAssignments ?? "?"} assignment(s) removed`));
        return 0;
      }

      case "get": {
        if (!args[0]) { console.error("usage: darth-cli meetings get <id>"); return 1; }
        const data = await ctx.expectJson<{ transcript: any }>(ctx.api("meetings", `/api/transcripts/${args[0]}`));
        const t = data.transcript;
        ctx.print(t, () => {
          console.log(`id:          ${t.assemblyai_id}`);
          console.log(`title:       ${t.title || t.original_filename || "(untitled)"}`);
          if (t.description) console.log(`description: ${t.description}`);
          console.log(`date:        ${t.recorded_at || t.completed_at || t.created_at}`);
          console.log(`duration:    ${fmtDuration(t.duration)}  speakers: ${t.speaker_count ?? "?"}  status: ${t.status}`);
          console.log(`access:      ${t.access}  source: ${t.source}${t.local_audio_path ? "  (audio stored locally)" : ""}`);
          console.log(`notes:       ${t.auto_notes_status ?? "never run"}${t.auto_notes ? ` (${t.auto_notes.length} chars)` : ""}`);
          console.log(`report:      ${t.auto_report_status ?? "never run"}${t.auto_report ? ` (${t.auto_report.length} chars)` : ""}`);
        });
        return 0;
      }

      case "text": {
        if (!args[0]) { console.error("usage: darth-cli meetings text <id>"); return 1; }
        const rendered = await fetchTranscriptText(ctx, args[0], p => ctx.expectJson<any>(ctx.api("meetings", p)));
        console.log(rendered.text);
        return 0;
      }

      case "notes":
      case "report": {
        if (!args[0]) { console.error(`usage: darth-cli meetings ${cmd} <id>`); return 1; }
        const data = await ctx.expectJson<{ transcript: any }>(ctx.api("meetings", `/api/transcripts/${args[0]}`));
        const t = data.transcript;
        const md = cmd === "notes" ? t.auto_notes : t.auto_report;
        const status = cmd === "notes" ? t.auto_notes_status : t.auto_report_status;
        if (!md) {
          console.error(`No ${cmd} yet (status: ${status ?? "never run"}). An agent can create them: see 'darth-cli meetings skill'.`);
          return 1;
        }
        console.log(md);
        return 0;
      }

      case "search": {
        const q = args.join(" ").trim();
        if (q.length < 2) { console.error("usage: darth-cli meetings search <query> [--regex] [--participant --organizer --provider --speaker]  (2+ chars)"); return 1; }
        const fr = readFilterFlags(ctx, flags, PEOPLE_FLAGS);
        if (!fr.ok) { console.error(fr.error); return 1; }
        fr.params.set("q", q);
        if (flags.regex === true) fr.params.set("regex", "1");
        const data = await ctx.expectJson<{ hits: any[] }>(
          ctx.api("meetings", `/api/transcripts/search?${fr.params.toString()}`));
        ctx.print(data.hits, () => {
          if (!data.hits.length) return console.log("No matches.");
          for (const h of data.hits) {
            console.log(`${h.assemblyai_id}  [${h.matched_in}]${h.snippet ? `  …${h.snippet}…` : ""}`);
          }
          console.log(`\n${data.hits.length} hit(s) — 'darth-cli meetings text <id>' for the full transcript`);
        });
        return 0;
      }

      case "series": {
        const sub = args[0];
        const asId = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);
        // -- index / one series ------------------------------------------
        if (!sub || asId(sub) !== null) {
          if (!sub) {
            const data = await ctx.expectJson<{ series: any[]; totals: any }>(ctx.api("meetings", `/api/series`));
            ctx.print(data, () => {
              if (!data.series.length) return console.log("No series visible to you.");
              for (const r of data.series) {
                const bits = [
                  String(r.id).padStart(4),
                  (r.cadence ?? "ad-hoc").padEnd(8),
                  `${String(r.member_count).padStart(3)} imported`,
                  r.auto_enabled ? "auto" : "    ",
                  r.dup ? `DUP?(${r.dup_with.map((d: any) => d.id).join(",")})` : "",
                ];
                console.log(`${bits.join("  ")}  ${r.title}`);
              }
              console.log(`\n${data.series.length} series — 'series <id>' for details`);
            });
            return 0;
          }
          const id = asId(sub)!;
          const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/series/${id}`));
          ctx.print(data, () => {
            const sr = data.series;
            console.log(`series:      #${sr.id}  ${sr.title}`);
            const ai = sr.auto_import;
            console.log(`auto-import: ${ai?.enabled ? `ON (mode ${ai.mode}, report ${ai.report}, by ${ai.byEmail})` : "off"}`);
            if (sr.notes) console.log(`notes:       ${sr.notes.split("\n")[0]}`);
            console.log(`keys:        ${data.keys.map((k: any) => `${k.kind}=${k.value.length > 40 ? k.value.slice(0, 40) + "…" : k.value}`).join("  ") || "(none)"}`);
            console.log(`members (${data.members.length}):`);
            for (const m of data.members) {
              console.log(`  ${m.assemblyai_id ?? "(hidden)"}  ${m.recorded_at?.slice(0, 10) ?? "????-??-??"}  ${m.visible === false ? "(not visible to you)" : (m.title ?? "")}`);
            }
            if (data.suggestions?.length) {
              console.log(`suggested (unconfirmed): ${data.suggestions.length} — confirm in the web UI or 'series attach'`);
            }
            if (data.dupes?.length) {
              console.log(`probable duplicates: ${data.dupes.map((d: any) => `#${d.id} ${d.title}`).join(", ")} — 'series merge ${sr.id} <from-id>' to fold`);
            }
          });
          return 0;
        }
        // -- mutations ----------------------------------------------------
        ctx.requireWrite();
        if (sub === "set") {
          const id = asId(args[1]);
          if (!id) { console.error("usage: darth-cli meetings series set <id> [--title <t>] [--notes <md>] [--auto-import on|off] [--mode ...] [--report ...]"); return 1; }
          const body: any = {};
          if (str(flags.title) !== undefined) body.title = str(flags.title);
          if (str(flags.notes) !== undefined) body.notes = str(flags.notes);
          const ai = str(flags["auto-import"]);
          if (ai !== undefined) {
            if (ai !== "on" && ai !== "off") { console.error("--auto-import must be on or off"); return 1; }
            body.autoImport = { enabled: ai === "on" };
            const mode = str(flags.mode); const report = str(flags.report);
            if (mode) body.autoImport.mode = mode;
            if (report) body.autoImport.report = report;
          }
          if (!Object.keys(body).length) { console.error("nothing to change — pass --title/--notes/--auto-import"); return 1; }
          await ctx.expectJson(ctx.api("meetings", `/api/series/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
          if (!ctx.json) console.log("Updated.");
          return 0;
        }
        if (sub === "merge") {
          const into = asId(args[1]); const from = asId(args[2]);
          if (!into || !from) { console.error("usage: darth-cli meetings series merge <into-id> <from-id>"); return 1; }
          await ctx.expectJson(ctx.api("meetings", `/api/series/${into}/merge`, { method: "POST", body: JSON.stringify({ fromSeriesId: from }) }));
          if (!ctx.json) console.log(`Merged #${from} into #${into} (keys+members moved, #${from} deleted).`);
          return 0;
        }
        if (sub === "attach" || sub === "detach") {
          const id = asId(args[1]); const tid = args[2];
          if (!id || !tid) { console.error(`usage: darth-cli meetings series ${sub} <series-id> <transcript-id>`); return 1; }
          if (sub === "attach") {
            await ctx.expectJson(ctx.api("meetings", `/api/series/${id}/members`, {
              method: "POST", body: JSON.stringify({ transcriptId: tid, how: flags.manual === true ? "manual" : "confirmed" }) }));
            if (!ctx.json) console.log("Attached.");
          } else {
            const qs = new URLSearchParams({ transcriptId: tid });
            if (flags.remember === true) qs.set("remember", "1");
            await ctx.expectJson(ctx.api("meetings", `/api/series/${id}/members?${qs}`, { method: "DELETE" }));
            if (!ctx.json) console.log(flags.remember === true ? "Detached (and won't be re-suggested)." : "Detached.");
          }
          return 0;
        }
        console.error(`unknown series subcommand '${sub}' — try: series | series <id> | set | merge | attach | detach`);
        return 1;
      }

      case "import": {
        const ref = args[0]?.trim();
        if (!ref) { console.error("usage: darth-cli meetings import <meeting-code|event-key> [--mode transcript|video|both] [--wait] [--timeout <mins>]"); return 1; }
        ctx.requireWrite();
        const mode = str(flags.mode) || "transcript";
        if (!["transcript", "video", "both"].includes(mode)) { console.error("--mode must be transcript, video or both"); return 1; }
        // '<eventId>|<startIso>' = event key; anything else = meeting code.
        const body = ref.includes("|") ? { eventKey: ref, mode } : { meetingCode: ref, mode };
        const res = await ctx.api("meetings", `/api/meetings/import`, {
          method: "POST", body: JSON.stringify(body) });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
          console.error(`Import failed (HTTP ${res.status}): ${data?.error ?? "unknown error"}`);
          return 1;
        }
        let t: any = data.transcript;
        const mUrl = data.meetingUrl ? `${webBase(ctx)}${data.meetingUrl}` : null;
        const say = (line: string) => { if (!ctx.json) console.log(line); };
        say(res.status === 201
          ? `Imported: ${t?.assemblyai_id}  "${t?.title ?? ""}"`
          : `Queued (${data.waitingFor ?? "processing"}): ${t?.assemblyai_id}`);
        if (mUrl) say(`Link (stable): ${mUrl}`);
        if (flags.wait === true && res.status === 202 && t?.assemblyai_id) {
          const capMin = Number(str(flags.timeout) ?? "30");
          if (!Number.isFinite(capMin) || capMin <= 0) {
            console.error(`--timeout must be a number of minutes (got '${str(flags.timeout)}')`);
            return 1;
          }
          const deadline = Date.now() + capMin * 60_000;
          let id: string = t.assemblyai_id;
          let gone = 0; // consecutive polls where BOTH resolve and get 404'd
          say(`Waiting for completion (up to ${capMin} min, poll 10s)…`);
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10_000));
            // Placeholder ids get renamed on promotion — re-resolve each poll.
            const rr = await ctx.api("meetings", `/api/meetings/resolve?any=${encodeURIComponent(id)}`);
            if (rr.ok) {
              const j: any = await rr.json().catch(() => null);
              if (j?.transcriptId && j.transcriptId !== id) { id = j.transcriptId; say(`… promoted to ${id}`); }
            }
            const gr = await ctx.api("meetings", `/api/transcripts/${id}`);
            if (!gr.ok) {
              // One 404 can be the promotion gap; SIX in a row (a minute)
              // with resolve also blank means the queued row was retired
              // without a successor (e.g. Google's transcript Doc was empty)
              // — stop instead of spinning to the timeout.
              gone = !rr.ok && gr.status === 404 ? gone + 1 : 0;
              if (gone >= 6) {
                console.error(
                  "The queued import is gone without a successor — most often the provider's transcript was empty (nothing to import). Check the meeting in the web app."
                );
                return 1;
              }
              continue;
            }
            gone = 0;
            const gj: any = await gr.json().catch(() => null);
            const st = gj?.transcript?.status;
            if (st === "completed") { t = gj.transcript; say(`Done: ${id}  "${t.title ?? ""}"  (${fmtDuration(t.duration)})`); ctx.print({ transcript: t, meetingUrl: mUrl }, () => {}); return 0; }
            if (st === "error") { console.error(`Import errored: ${gj?.transcript?.error ?? "see the web app"}`); return 1; }
          }
          console.error(`Still not done after ${capMin} min — it keeps running server-side; check later with 'get ${id}'.`);
          return 1;
        }
        ctx.print({ status: res.status, transcript: t, meetingUrl: mUrl }, () => {});
        return 0;
      }

      case "export": {
        const outDir = str(flags["out-dir"]) || str(flags.out);
        if (!outDir) { console.error("usage: darth-cli meetings export --out-dir <dir> [--label <path|#id|none> [--exact]] [--participant --organizer --provider --speaker --q --from --to] [--format text|json] [--force]"); return 1; }
        const format = str(flags.format) || "text";
        if (format !== "text" && format !== "json") { console.error("--format must be text or json"); return 1; }
        const force = flags.force === true;
        const fr = readFilterFlags(ctx, flags, [...ALL_FILTER_FLAGS, "label", "exact"]);
        if (!fr.ok) { console.error(fr.error); return 1; }
        const lf = await resolveLabelFilter(ctx, flags, fr.params);
        const { rows } = await drainDayPages<any, any>(ctx, "/api/transcripts?v=2&tab=all", fr.params);
        mkdirSync(outDir, { recursive: true });
        const ext = format === "json" ? "json" : "txt";
        const written: any[] = [], skipped: any[] = [], failed: any[] = [];
        const say = (line: string) => { if (!ctx.json) console.log(line); };
        if (lf.active) {
          // Label mirror: <dir>/<label path>/<date> <title> (<id>)/{meta.json,
          // text.txt,notes.md,report.md}. A transcript lands once per MATCHING
          // label (exact → only the filter label; default → the filter label
          // and any sub-label it carries). `--label none` → <dir>/_unlabelled.
          const rootKey = lf.root?.path_key ?? "";
          const relById = exportRelPaths(lf.rows);
          const relOf = (l: LabelRef) => relById.get(l.id) ?? splitLabelPath(l.path).map(s => fsSegment(s)).join("/");
          for (const t of rows) {
            const id: string = t.assemblyai_id;
            const title = t.title || t.original_filename || "(untitled)";
            const date = transcriptDate(t) || "undated";
            const labels: LabelRef[] = Array.isArray(t.labels) ? t.labels : [];
            const targets = lf.none
              ? ["_unlabelled"]
              : labels.filter(l => underLabel(labelPathKey(l.path), rootKey, lf.exact)).map(relOf);
            if (!targets.length) targets.push(lf.root ? relOf(lf.root) : "_unlabelled");
            const leaf = `${date} ${fsSegment(title, 80)} (${id})`;
            const dirs = [...new Set(targets)].map(rel => join(outDir, rel, leaf));
            if (t.status !== "completed") {
              for (const dir of dirs) { skipped.push({ id, file: dir, reason: `status ${t.status}` }); say(`skip   ${dir}  (status: ${t.status})`); }
              continue;
            }
            const todo = dirs.filter(dir => {
              if (!force && existsSync(join(dir, "text.txt"))) { skipped.push({ id, file: dir, reason: "exists" }); say(`skip   ${dir}  (exists — --force to rewrite)`); return false; }
              return true;
            });
            if (!todo.length) continue;
            try {
              const [rendered, detail] = await Promise.all([
                fetchTranscriptText(ctx, id, p => getJsonOrThrow(ctx, p)),
                getJsonOrThrow(ctx, `/api/transcripts/${id}`) as Promise<{ transcript: any }>,
              ]);
              const tr = detail.transcript || {};
              const meta = {
                id, title, date, recorded_at: t.recorded_at ?? null, duration: t.duration ?? null, speaker_count: t.speaker_count ?? null,
                provider: t.provider ?? null, access: t.access, owner_email: t.owner_email ?? null, participants: t.participants ?? [],
                labels, description: tr.description ?? null, notes_status: tr.auto_notes_status ?? null, report_status: tr.auto_report_status ?? null,
                web: `/transcript/${id}`,
              };
              const textBody = rendered.text + "\n";
              for (const dir of todo) {
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
                writeFileSync(join(dir, "text.txt"), textBody);
                const files = ["meta.json", "text.txt"];
                if (format === "json") { writeFileSync(join(dir, "lines.json"), JSON.stringify(rendered.lines, null, 2) + "\n"); files.push("lines.json"); }
                if (tr.auto_notes) { writeFileSync(join(dir, "notes.md"), String(tr.auto_notes).replace(/\n?$/, "\n")); files.push("notes.md"); }
                if (tr.auto_report) { writeFileSync(join(dir, "report.md"), String(tr.auto_report).replace(/\n?$/, "\n")); files.push("report.md"); }
                written.push({ id, file: dir, title, date, lines: rendered.lines.length, files, bytes: Buffer.byteLength(textBody) });
                say(`wrote  ${dir}/  (${files.join(", ")})`);
              }
            } catch (e: any) {
              for (const dir of todo) { failed.push({ id, file: dir, error: e?.message || String(e) }); say(`FAIL   ${dir}  (${e?.message || e})`); }
            }
          }
          const manifest = { outDir, format, layout: "labels", label: lf.none ? "none" : lf.root?.path, exact: lf.exact, matched: rows.length, written, skipped, failed };
          ctx.print(manifest, () =>
            console.log(`\n${rows.length} matched → ${written.length} folder(s) written, ${skipped.length} skipped, ${failed.length} failed  (${outDir})`));
          return failed.length ? 1 : 0;
        }
        for (const t of rows) {
          const id: string = t.assemblyai_id;
          const title = t.title || t.original_filename || "(untitled)";
          const date = transcriptDate(t) || "undated";
          const file = join(outDir, `${date}-${slugify(title)}-${id}.${ext}`);
          if (t.status !== "completed") {
            skipped.push({ id, file, reason: `status ${t.status}` });
            say(`skip   ${file}  (status: ${t.status})`);
            continue;
          }
          if (!force && existsSync(file)) {
            skipped.push({ id, file, reason: "exists" });
            say(`skip   ${file}  (exists — --force to rewrite)`);
            continue;
          }
          try {
            const rendered = await fetchTranscriptText(ctx, id, p => getJsonOrThrow(ctx, p));
            const body = format === "json"
              ? JSON.stringify({
                  id, title, date,
                  recorded_at: t.recorded_at ?? null, duration: t.duration ?? null, speaker_count: t.speaker_count ?? null,
                  provider: t.provider ?? null, access: t.access, owner_email: t.owner_email ?? null,
                  participants: t.participants ?? [], labels: t.labels ?? [], lines: rendered.lines, text: rendered.text,
                }, null, 2) + "\n"
              : rendered.text + "\n";
            writeFileSync(file, body);
            written.push({ id, file, title, date, lines: rendered.lines.length, bytes: Buffer.byteLength(body) });
            say(`wrote  ${file}  (${rendered.lines.length ? `${rendered.lines.length} lines` : "flat text"}, ${Buffer.byteLength(body)} bytes)`);
          } catch (e: any) {
            failed.push({ id, file, error: e?.message || String(e) });
            say(`FAIL   ${file}  (${e?.message || e})`);
          }
        }
        const manifest = { outDir, format, matched: rows.length, written, skipped, failed };
        ctx.print(manifest, () =>
          console.log(`\n${rows.length} matched → ${written.length} written, ${skipped.length} skipped, ${failed.length} failed  (${outDir})`));
        return failed.length ? 1 : 0;
      }

      case "calendar": {
        const view = str(flags.view) || "unimported";
        if (view !== "unimported" && view !== "norec") { console.error("--view must be unimported or norec"); return 1; }
        const fr = readFilterFlags(ctx, flags, ["participant", "organizer", "provider", "q", "from", "to"]);
        if (!fr.ok) { console.error(fr.error); return 1; }
        const { rows, counts } = await drainDayPages<any, { unimported: number; norec: number }>(
          ctx, `/api/calendar-meetings?view=${view}`, fr.params);
        const tz = localTz(ctx);
        ctx.print({ view, counts, rows }, () => {
          if (!rows.length) {
            console.log(view === "unimported"
              ? "No un-imported recordings/transcripts match (calendar layer empty for those filters)."
              : "No recording-less calendar events match.");
          }
          for (const r of rows) {
            const { evidence, importable } = calendarEvidence(r);
            const cols = [
              fmtLocalDateTime(r.eventStart, tz),
              r.provider.padEnd(5),
              evidence.padEnd(24),
              (importable ? "importable" : "-").padEnd(10),
              (r.organizerEmail || "?").padEnd(28),
              r.title || "(untitled)",
            ];
            const tail = [r.meetingCode ? `[${r.meetingCode}]` : null, r.muted ? "(muted)" : null].filter(Boolean).join(" ");
            console.log(`${cols.join("  ")}${tail ? `  ${tail}` : ""}`);
          }
          console.log(`\n${rows.length} ${view} row(s) shown (tz ${tz}) · after filters: ${counts.unimported ?? "?"} unimported, ${counts.norec ?? "?"} no-recording · none of these are in the archive yet`);
        });
        return 0;
      }

      case "audio": {
        if (!args[0]) { console.error("usage: darth-cli meetings audio <id> [--out <file>]"); return 1; }
        return download(ctx, `/api/transcripts/${args[0]}/audio`, str(flags.out), args[0]);
      }

      case "frame": {
        if (!args[0] || !args[1]) { console.error("usage: darth-cli meetings frame <id> <ms|mm:ss|hh:mm:ss> [--out <file>]"); return 1; }
        const ms = parseTs(args[1]);
        if (ms === null) { console.error(`bad timestamp '${args[1]}' — use ms, mm:ss or hh:mm:ss`); return 1; }
        return download(ctx, `/api/transcripts/${args[0]}/frames/${ms}.jpg`, str(flags.out), `${args[0]}-${ms}`);
      }

      case "attachments": {
        if (!args[0]) { console.error("usage: darth-cli meetings attachments <id>"); return 1; }
        const data = await ctx.expectJson<{ attachments: any[] }>(
          ctx.api("meetings", `/api/transcripts/${args[0]}/attachments`));
        ctx.print(data.attachments, () => {
          if (!data.attachments.length) return console.log("No attachments.");
          for (const a of data.attachments) {
            console.log(`${String(a.id).padStart(5)}  ${a.kind || "file"}  ${a.title || a.filename || "(untitled)"}`);
          }
        });
        return 0;
      }

      case "attachment-get": {
        if (!args[0] || !args[1]) { console.error("usage: darth-cli meetings attachment-get <id> <attachmentId> [--out <file>]"); return 1; }
        return download(ctx, `/api/transcripts/${args[0]}/attachments/${args[1]}/download`, str(flags.out), `attachment-${args[1]}`);
      }

      case "set-title": {
        if (!args[0] || !args[1]) { console.error("usage: darth-cli meetings set-title <id> <title>"); return 1; }
        ctx.requireWrite();
        const title = args.slice(1).join(" ");
        await ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${args[0]}`, {
          method: "PATCH", body: JSON.stringify({ title }),
        }));
        console.log(`Title set: ${title}`);
        return 0;
      }

      case "set-notes":
      case "set-report": {
        if (!args[0]) { console.error(`usage: darth-cli meetings ${cmd} <id> --file <markdown-file|->`); return 1; }
        ctx.requireWrite();
        const markdown = readMarkdownFlag(str(flags.file));
        if (markdown === null) { console.error(`--file is required ('-' reads stdin)`); return 1; }
        if (!markdown.trim()) { console.error("markdown is empty"); return 1; }
        const kind = cmd === "set-notes" ? "notes" : "report";
        await ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${args[0]}/${kind}`, {
          method: "PUT", body: JSON.stringify({ markdown }),
        }));
        console.log(`${kind} updated (${markdown.length} chars) — visible in the web UI now`);
        return 0;
      }

      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(HELP);
        return 1;
    }
  },
};

export default meetings;
