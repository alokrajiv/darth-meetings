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
                                  --participant/--organizer/--provider/--speaker
                                  narrow the hits (no --from/--to/--q here)
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

WRITE (needs read+write for meetings)
  set-title <id> <title>          Update the title
  set-notes <id> --file <md|->    Replace the notes markdown ('-' = stdin)
  set-report <id> --file <md|->   Replace the report markdown ('-' = stdin)
  skill                           Print the agent workflow guide

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
Tab counts / totals printed alongside already reflect the filters.
'list --json' / 'export' rows carry "participants": [emails] (organizer first).

IDS: <id> is the transcript id shown by 'list' (also in web URLs:
/transcript/<id>). Timestamps in 'text' output are utterance starts — feed
them to 'frame' to see what was on screen at that moment. 'calendar' rows
are NOT importable by id from here — they show [meeting-code] for
cross-reference; importing stays a web-UI action (your own Google token).

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

'search <query>' is a server-side deep search (ILIKE) across titles,
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
function readFilterFlags(ctx: Ctx, flags: Record<string, string | boolean>, allow: readonly string[]): FilterRead {
  const params = new URLSearchParams();
  let active = false;
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
    console.log(`${t.assemblyai_id}  ${date}  ${fmtDuration(t.duration).padStart(7)}  ${String(t.speaker_count ?? "?").padStart(2)}sp  ${title}${flagsCol ? `  [${flagsCol}]` : ""}`);
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
    const [, cmd, ...args] = pos.length && pos[0] === "meetings" ? pos : ["", ...pos];
    if (!cmd || flags.help === true) { console.log(HELP); return 0; }

    switch (cmd) {
      case "skill": {
        console.log(SKILL);
        return 0;
      }

      case "whoami": {
        const data = await ctx.expectJson<any>(ctx.api("meetings", "/api/whoami"));
        ctx.print(data, () =>
          console.log(`${data.email} (${data.userId}) via ${data.via}${data.scope ? `, meetings scope: ${data.scope}` : ""}`));
        return 0;
      }

      case "list": {
        const fr = readFilterFlags(ctx, flags, ALL_FILTER_FLAGS);
        if (!fr.ok) { console.error(fr.error); return 1; }
        if (!fr.active) {
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
          console.log(`\n${rows.length} transcript(s) matching — ${counts.mine ?? "?"} yours, ${counts.shared ?? "?"} shared with you`);
        });
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
        if (q.length < 2) { console.error("usage: darth-cli meetings search <query> [--participant --organizer --provider --speaker]  (2+ chars)"); return 1; }
        const fr = readFilterFlags(ctx, flags, PEOPLE_FLAGS);
        if (!fr.ok) { console.error(fr.error); return 1; }
        fr.params.set("q", q);
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

      case "export": {
        const outDir = str(flags["out-dir"]) || str(flags.out);
        if (!outDir) { console.error("usage: darth-cli meetings export --out-dir <dir> [--participant --organizer --provider --speaker --q --from --to] [--format text|json] [--force]"); return 1; }
        const format = str(flags.format) || "text";
        if (format !== "text" && format !== "json") { console.error("--format must be text or json"); return 1; }
        const force = flags.force === true;
        const fr = readFilterFlags(ctx, flags, ALL_FILTER_FLAGS);
        if (!fr.ok) { console.error(fr.error); return 1; }
        const { rows } = await drainDayPages<any, any>(ctx, "/api/transcripts?v=2&tab=all", fr.params);
        mkdirSync(outDir, { recursive: true });
        const ext = format === "json" ? "json" : "txt";
        const written: any[] = [], skipped: any[] = [], failed: any[] = [];
        const say = (line: string) => { if (!ctx.json) console.log(line); };
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
                  participants: t.participants ?? [], lines: rendered.lines, text: rendered.text,
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
