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
import { readFileSync, writeFileSync } from "node:fs";

const HELP = `darth-cli meetings — meeting transcripts, notes & recordings (darth-meetings)

USAGE
  darth-cli meetings <command> [args] [--json]

AI agents: run 'darth-cli meetings skill' FIRST — it explains the intended
agent workflow (fetch text → think with YOUR model → write notes back).

READ
  whoami                          Identity + effective scope as the service sees it
  list                            Transcripts you own or shared with you
  get <id>                        One transcript's metadata + AI-notes/report status
  text <id>                       Full transcript as "[mm:ss] Speaker: …" lines
                                  (confirmed speaker names applied; grep/regex this)
  notes <id>                      Print the meeting-notes markdown
  report <id>                     Print the detailed-report markdown
  search <query>                  Server-side deep search (title, filename,
                                  description, notes, full text) with snippets
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

IDS: <id> is the transcript id shown by 'list' (also in web URLs:
/transcript/<id>). Timestamps in 'text' output are utterance starts — feed
them to 'frame' to see what was on screen at that moment.

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

## Searching

'search <query>' is a server-side deep search (ILIKE) across titles,
filenames, descriptions, notes and full transcript text — use it to FIND
meetings. For regex/precise analysis, fetch 'text <id>' and grep locally.

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
        const data = await ctx.expectJson<{ transcripts: any[] }>(ctx.api("meetings", "/api/transcripts"));
        const rows = data.transcripts;
        ctx.print(rows, () => {
          if (!rows.length) return console.log("No transcripts visible to you yet.");
          for (const t of rows) {
            const date = (t.recorded_at || t.completed_at || t.created_at || "").slice(0, 10);
            const title = t.title || t.original_filename || "(untitled)";
            const flagsCol = [
              t.status !== "completed" ? t.status : null,
              t.access !== "owner" ? t.access : null,
              t.auto_notes ? "notes" : null,
              t.auto_report ? "report" : null,
            ].filter(Boolean).join(",");
            console.log(`${t.assemblyai_id}  ${date}  ${fmtDuration(t.duration).padStart(7)}  ${String(t.speaker_count ?? "?").padStart(2)}sp  ${title}${flagsCol ? `  [${flagsCol}]` : ""}`);
          }
          console.log(`\n${rows.length} transcript(s)`);
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
        const id = args[0];
        const [content, speakers] = await Promise.all([
          ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${id}/content`)),
          ctx.expectJson<{ speakerLabels: Array<{ originalSpeaker: string; customName: string }> }>(
            ctx.api("meetings", `/api/transcripts/${id}/speakers`)),
        ]);
        const names = new Map(speakers.speakerLabels.map(l => [l.originalSpeaker, l.customName]));
        const utterances: any[] = content.utterances || [];
        if (!utterances.length) {
          // no diarization — fall back to the flat text
          console.log(content.text || "(empty transcript)");
          return 0;
        }
        for (const u of utterances) {
          const name = names.get(u.speaker) || `Speaker ${u.speaker}`;
          console.log(`[${fmtMs(u.start)}] ${name}: ${u.text}`);
        }
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
        if (q.length < 2) { console.error("usage: darth-cli meetings search <query>  (2+ chars)"); return 1; }
        const data = await ctx.expectJson<{ hits: any[] }>(
          ctx.api("meetings", `/api/transcripts/search?q=${encodeURIComponent(q)}`));
        ctx.print(data.hits, () => {
          if (!data.hits.length) return console.log("No matches.");
          for (const h of data.hits) {
            console.log(`${h.assemblyai_id}  [${h.matched_in}]${h.snippet ? `  …${h.snippet}…` : ""}`);
          }
          console.log(`\n${data.hits.length} hit(s) — 'darth-cli meetings text <id>' for the full transcript`);
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
