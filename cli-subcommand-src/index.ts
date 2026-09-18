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
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

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
  list --scratch                  Your temporary (scratch) transcripts only —
                                  'upload --scratch' rows; hidden from the
                                  archive, trashed 30 days after creation
                                  unless kept in the web UI or linked. No
                                  other filters (legacy shape)
  get <id>                        One transcript's metadata + AI-notes/report status
                                  ('scratch: yes' marks a temporary row)
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
  calendar [--view unimported|norec|all] [FILTERS except --speaker]
                                  Calendar-layer meetings that are NOT in the
                                  archive: unimported = a recording/transcript
                                  exists at Google/Microsoft but nobody imported
                                  it (default); norec = your past calendar
                                  events that left no artifacts at all
  calendar --view all [--from D] [--to D] [--details] [--cached] [FILTERS except --speaker]
                                  Your FULL calendar as an agenda: every timed
                                  event (past + upcoming, imported or not,
                                  with or without a meeting link). Re-reads the
                                  window live from Google with your own link
                                  (--cached = server cache only). Default
                                  window: 7 days back → 30 days ahead; one
                                  bound given → 90 days from/to it; max 366.
                                  Imported rows end with "→ <id> (notes+report)"
                                  so you can go straight to 'text <id>';
                                  no-access imports name the owner to ask;
                                  series:"…" = the recurring-call series.
                                  --details adds where / attendees (with
                                  declined/tentative) / /m link + transcript
                                  url / Google Calendar link / invite text /
                                  key (the exact event key for 'upload
                                  --event' and 'link') under each row. --json
                                  has it all always
  audio <id> [--out <file>]       Download the recording (default ./<id>.<ext>)
  frame <id> <ts> [--out <file>]  Grab a video frame at a timestamp (ms, mm:ss or
                                  hh:mm:ss) as jpeg — only transcripts imported
                                  from a video recording have frames
  speakers <id>                   Diarized speakers of a transcript: confirmed
                                  name (if a human set one) + the machine's
                                  guess (name, confidence, voice|context) +
                                  the speaker-ID pass status
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
  offline plan [<id,…>]           What the web app keeps offline for you under
                                  the auto-pin counts (newest N: transcript
                                  → audio → video ladder) with the stored
                                  recording sizes; with ids: exactly those
                                  meetings (absent = no longer available)
  offline prefs                   Your offline auto-pin counts (transcripts /
                                  audio / video) with defaults and caps

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
  upload <file> [--event <meeting-code|event-key>] [--title <t>]
         [--language <code>] [--scratch] [--resume] [--wait] [--timeout <mins>]
                                  Upload a recording (audio/video; text docs
                                  like .vtt/.txt/.docx go through the text
                                  importer) and transcribe it. --event links
                                  it to a calendar event up front (title,
                                  date, attendees, auto-share to invitees);
                                  without it the row is unlinked and you can
                                  'link' it later — same single transcription
                                  run either way. --scratch = temporary: kept
                                  out of everyone's main archive ('list
                                  --scratch' / the web UI's Temporary tab)
                                  and trashed 30 days after creation unless
                                  kept in the web UI or linked. --wait polls
                                  until transcription AND the speaker-ID
                                  guess finish, then prints 'speakers'.
                                  Uploads get summary notes only — a detailed
                                  report is requested by a human in the web UI.
                                  Media over 8 MB goes up RESUMABLE: the file
                                  is hashed, then sent as parallel verified
                                  pieces (through the VM, or straight to
                                  Azure Blob when the server offers it — its
                                  call). A drop costs one piece; Ctrl-C /
                                  a crash leaves the session on the server
                                  for 24 h and re-running the SAME command
                                  on the same file continues where it
                                  stopped (--resume just makes a fresh start
                                  say so). Progress goes to stderr (not with
                                  --json). ≤ 8 MB and text docs: one request
  link <id> <meeting-code|event-key>
                                  Attach an existing transcript (typically an
                                  unlinked upload) to a calendar event: sets
                                  date + empty title + attendees, lights up
                                  share suggestions, and re-runs the speaker
                                  guess with the attendee list unless a human
                                  already confirmed names. Metadata only —
                                  nothing is re-transcribed
  set-date <id> <when>            Set the meeting date/time of a transcript
                                  (ISO 8601, 'YYYY-MM-DD HH:mm' in your tz,
                                  or 'YYYY-MM-DD' = noon). For recordings
                                  that match no calendar event
  set-speakers <id> <Speaker>=<Name> ...
                                  Confirm speaker names ('A="Jane Doe"'); the
                                  names apply to 'text' output and enrol the
                                  person's voiceprint. Others keep their
                                  current label; '--clear' unsets all first
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
  offline prefs --set <k>=<n>[,<k>=<n>…]
                                  Change the offline auto-pin counts
                                  (transcripts / audio / video; capped
                                  server-side). Applies to every device of
                                  this account
  set-title <id> <title>          Update the title
  set-notes <id> --file <md|->    Replace the notes markdown ('-' = stdin)
  set-report <id> --file <md|->   Replace the report markdown ('-' = stdin)
  trash <id>                      Move a transcript you OWN to the trash (soft
                                  delete: gone from listings/search/series for
                                  everyone, transcript + audio + notes kept).
                                  Reversible with 'restore'; permanent
                                  deletion is web-only (Trash tab)
  restore <id>                    Bring a trashed transcript back (owner only)
  label / unlabel / label-create / label-rename / label-mv / label-rm
                                  (label/unlabel also need owner or edit access
                                  on that transcript; readers get 403)
  skill                           Print the agent workflow guide

ACCOUNT-SETTINGS writes ('auto-sync off|mine|all', 'notify <kind> on|off',
'offline prefs --set')
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

The CLI never starts the service's own AI runs: an upload gets the default
summary notes, and a DETAILED report is something a human requests in the
web UI (Generate…). You READ whatever exists with 'report <id>' and WRITE
your own with 'set-report <id> --file report.md' — that is the whole point.

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
tell a human "these 3 meetings have recordings nobody imported", then
'import <meeting-code>' pulls one in server-side. 'calendar --view all' is the human's FULL
calendar (past + upcoming, everything) — the answer to "what's on my
calendar next week", "who am I meeting on Thursday", "which of last
month's calls were recorded / imported": imported rows end with "→ <id>"
(then 'text <id>' / 'notes <id>' — the tail says whether notes/report are
ready), plus the provider evidence, organiser, attendee count, series.
--details adds location, attendee emails + RSVP, the stable /m link, the
Google Calendar link and the invite text; --json has every field always.

## Someone hands you a recording ("here's the audio, do your thing")

People will drop an audio/video file on you without saying which meeting
it was. The system is built so this costs ONE transcription run: upload
first, decide what it belongs to afterwards. Linking later is a metadata
write (date, title, attendees, share suggestions) — nothing is re-run.

    # 1. If you ALREADY know the event, link up front (best case: title,
    #    date, attendees + auto-share to the invitees all land at once):
    darth-cli meetings calendar --view all --from 2026-09-15 --to 2026-09-15 --json
    darth-cli meetings upload ./call.m4a --event abc-defg-hij --wait
    darth-cli meetings upload ./call.m4a --event 'evt123|2026-09-15T06:00:00.000Z' --wait

    # 2. If you DON'T know: upload it unlinked and wait. --wait returns
    #    after transcription AND the speaker-ID guess (voiceprints +
    #    self-introductions), and prints 'speakers <id>' for you:
    darth-cli meetings upload ./call.m4a --wait
    darth-cli meetings text <id>            # skim: who, what, any dates said aloud

    # 3. Work out which calendar event it was. Signals you now hold: the
    #    guessed names, the duration, anything said in the first minutes
    #    ("thanks for joining the QBR"), and the file's own mtime. The upload
    #    date is NOT the meeting date — an unlinked row is stamped with the
    #    upload time. If the human didn't say when, ASK ("when was this
    #    recorded, roughly?") before searching the calendar.
    darth-cli meetings calendar --view all --from <day-2> --to <day+1> --participant "<guessed name>" --json
    #    Compare durationSecs with the transcript duration; prefer events
    #    whose attendees include the guessed names. Show the human the 1-3
    #    candidates (title, time, attendees) and let them pick — don't link
    #    on a coin flip. A [meeting-code] resolves to its LATEST past
    #    occurrence, so for an older occurrence of a recurring call pass the
    #    row's exact 'key' ('<eventId>|<startIso>') instead.

    # 4a. It matches an event → link it. Date, empty title and attendees come
    #     from the event; the speaker guess re-runs with the attendee list
    #     (unless names were already confirmed); invitees become share
    #     suggestions in the web UI. Works for events WITHOUT a meeting link
    #     too (in-person / phone calls) — use the key.
    darth-cli meetings link <id> 'evt123|2026-09-15T06:00:00.000Z'
    darth-cli meetings speakers <id>        # a minute later: refreshed guesses

    # 4b. No event matches (ad-hoc call, hallway chat) → settle it by hand:
    darth-cli meetings set-title <id> "Pricing call with Wei (ad hoc)"
    darth-cli meetings set-date <id> '2026-09-14 15:30'      # local time, or ISO
    #     Do NOT create a calendar event for it — the archive lists by date,
    #     a title + the right date is all it needs.

    # 5. Settle the speakers when you're confident (confirmed names flow
    #    into 'text', notes and the person's voiceprint — so only confirm what
    #    the human agreed to, and leave the rest as guesses):
    darth-cli meetings set-speakers <id> A="Wei Lin" B="Alok Rajiv"
    # 6. Then the normal loop: read 'text <id>', write notes with your model,
    #    'set-notes <id> --file notes.md'; 'label' it; share via the web UI.

Notes: media goes to AssemblyAI; .vtt/.srt/.txt/.docx/.pdf transcripts go
through the text importer (same verb, no transcription). Media over 8 MB is
sent resumable (hashed, parallel verified pieces, or straight to Azure Blob
when the server offers it): if the run dies or you Ctrl-C it, re-run the SAME
'upload' command on the SAME file within 24 h and it continues from what
already arrived — never re-upload under a new name. Multi-GB files are fine
but transcription time scales with length — raise --timeout. A 415 means the
server thinks the file is a text document under a media extension (or vice
versa) — rename it.

Someone hands you a THROWAWAY recording (a voice memo, a test clip, "just
tell me what they said") → 'upload --scratch'. It stays out of everyone's
main archive ('list --scratch' / the web UI's Temporary tab) and is trashed
30 days after creation unless a human keeps it in the web UI or you 'link'
it to a calendar event. Same transcription, same 'text' / 'speakers' /
'set-notes' afterwards — only the shelf life differs.

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
- 'trash <id>' is reversible ('restore <id>'; owner only) — the row just
  leaves everyone's listings. Permanent delete is web-only, on purpose.
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

/** Short status word for a full-calendar (`--view all`) row: what the
 * archive / provider hold for it, or that it hasn't happened yet. */
function calendarAllStatus(e: any): string {
  if (e.imported) {
    const st = e.imported.status && e.imported.status !== "completed" ? `(${e.imported.status})` : "";
    return e.imported.accessible ? `imported${st}` : `imported(no-access)${st}`;
  }
  if (e.upcoming) return "upcoming";
  const ev = e.evidence || {};
  if (ev.recording && ev.transcript) return "recording+transcript";
  if (ev.recording) return "recording";
  if (ev.transcript) return ev.geminiNotes ? "gemini-notes" : "transcript";
  if (ev.preparing) return "preparing";
  return e.meetingCode ? "no-artifacts" : "no-meet-link";
}

function fmtMins(secs: number | null): string {
  if (secs == null || !Number.isFinite(secs)) return "?";
  const m = Math.round(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}m`;
}

/** Collapse an invite description (often HTML) to one readable line. */
function oneLine(text: string, max: number): string {
  const t = text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * `calendar --view all` — GET /api/calendar/events: the caller's whole
 * calendar for a window (server re-reads it live from Google unless
 * --cached), ascending, with import / evidence annotations per row.
 */
/** Text documents the media route 415s — they go through the text importer. */
const TEXT_DOC_RE = /\.(txt|md|markdown|rtf|vtt|srt|docx|doc|pdf|json|csv|tsv|html|htm|log)$/i;
const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", weba: "audio/webm", aiff: "audio/aiff", aif: "audio/aiff",
  wma: "audio/x-ms-wma", amr: "audio/amr", caf: "audio/x-caf",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  avi: "video/x-msvideo", vtt: "text/vtt", srt: "text/plain", txt: "text/plain", md: "text/markdown",
  rtf: "application/rtf", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
function mimeFor(name: string): string { return MIME_BY_EXT[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream"; }

// ---------------------------------------------------------------------------
// Resumable uploads — the /api/uploads session family. The browser twin is
// src/lib/chunked-upload.ts (+ blob-blocks.ts for the Azure Blob mode); keep
// the two in step. This folder is copied into darth-cli at build time, so
// the constants and the Blob REST helpers are duplicated here on purpose.
//
//   1. sha256 the file (streamed) — the fingerprint the server resumes on
//      AND what the VM verifies a blob pull against.
//   2. POST /api/uploads {via:'blob', sha256, …} → a session. The same user +
//      fingerprint + size while a session is open comes back with what the
//      server already holds: THAT is resume. The server decides the byte
//      path: 'chunks' (PUT /api/uploads/:id/chunks/:idx through the VM,
//      sha256 per chunk) or 'blob' (4 MiB Put Block straight to a SAS URL,
//      commit with Put Block List; resume from Azure's uncommitted list).
//   3. POST …/complete — exactly-once; a lost reply is recovered by polling
//      GET /api/uploads/:id, a 409 {missing} re-syncs the chunks, a 409
//      {notCommitted} re-syncs the blocks, a 503 (VM pull hiccup) repeats.
// ---------------------------------------------------------------------------

/** At or below this the one-shot POST /api/transcripts is used (one request,
 * nothing worth resuming). Same line as the server's UPLOAD_BLOB_MIN_BYTES. */
const ONE_SHOT_MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_PARALLELISM = 4;
const MAX_CHUNK_ATTEMPTS = 40;
const BACKOFF_CAP_MS = 15_000;
/** One chunk / block PUT may take this long before it is retried. */
const PIECE_TIMEOUT_MS = 180_000;
/** Blob mode: keep retrying this long after the first failure before giving
 * up on THIS run (the next run resumes from Azure's block list anyway). */
const BLOB_RESUME_WINDOW_MS = 30 * 60_000;
const BLOB_BACKOFF_S = [1, 2, 4, 8, 15, 30];
const READ_HIGH_WATER = 8 * 1024 * 1024;

interface BlobTicket { sasUrl: string; blobName: string; blockBytes: number; parallel: number; expiresAt: string }
interface UploadSessionReply {
  id: string;
  /** Absent on an older server = chunks. */
  via?: "chunks" | "blob";
  chunkSize: number;
  chunkCount: number;
  received: number[];
  resumed: boolean;
  transcript: any;
  blob?: BlobTicket;
}

/** Terminal: the upload cannot proceed (the message is for the human). */
class UploadFailed extends Error { constructor(message: string, public status?: number) { super(message); this.name = "UploadFailed"; } }
/** The server no longer knows the session (404/410) or wants a chunk re-sync ('{…missing…}'). */
class SessionGone extends Error {}
/** …/complete on a blob session: Azure has no committed blob yet — re-sync the blocks. */
class NotCommitted extends Error {}
/** A Blob REST call failed (status 0 = network / timeout). */
class BlobFailed extends Error { constructor(message: string, public status = 0) { super(message); this.name = "BlobFailed"; } }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fmtMB = (b: number) => (b / 1048576).toFixed(1);

/** Progress on stderr: a live `\r` line on a TTY, one line per 10 % otherwise, nothing under --json. */
class UploadProgress {
  private lastLine = "";
  private lastAt = 0;
  private lastStep = -1;
  private readonly tty = !!process.stderr.isTTY;
  /** Highest byte count reported in the current phase (what a Ctrl-C message quotes). */
  seen = 0;
  constructor(private readonly enabled: boolean, private readonly total: number) {}
  set(phase: string, bytes: number): void {
    this.seen = phase === "Reading" ? 0 : Math.max(this.seen, bytes);
    if (!this.enabled) return;
    const pct = this.total ? Math.min(100, Math.floor((bytes / this.total) * 100)) : 100;
    const line = `${phase} ${fmtMB(bytes)} / ${fmtMB(this.total)} MB (${pct}%)`;
    if (this.tty) {
      const now = Date.now();
      if (line === this.lastLine || (now - this.lastAt < 200 && pct < 100)) return;
      process.stderr.write(`\r\x1b[K${line}`);
      this.lastLine = line; this.lastAt = now;
    } else {
      const step = Math.floor(pct / 10);
      if (step === this.lastStep) return;
      this.lastStep = step;
      console.error(line);
    }
  }
  /** A one-off line (retry notes, resume notice); keeps the live line tidy. */
  note(text: string): void {
    if (!this.enabled) return;
    if (this.tty && this.lastLine) process.stderr.write("\r\x1b[K");
    console.error(text);
    this.lastLine = "";
  }
  end(): void {
    if (this.enabled && this.tty && this.lastLine) { process.stderr.write("\n"); this.lastLine = ""; }
  }
}

/** One piece of the file as a plain Uint8Array (a fetch body as-is; Buffer's typing is not a BodyInit under the DOM lib). */
function readRange(fd: number, start: number, length: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(length));
  let off = 0;
  while (off < length) {
    const n = readSync(fd, buf, off, length - off, start + off);
    if (n <= 0) throw new UploadFailed(`Short read at byte ${start + off} — did the file change while uploading?`);
    off += n;
  }
  return buf;
}

async function sha256File(file: string, onBytes: (done: number) => void): Promise<string> {
  const h = createHash("sha256");
  let done = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: READ_HIGH_WATER })) {
    h.update(chunk as Buffer);
    done += (chunk as Buffer).length;
    onBytes(done);
  }
  return h.digest("hex");
}

function chunkRange(size: number, chunkSize: number, idx: number): { start: number; length: number } {
  const start = idx * chunkSize;
  return { start, length: Math.min(size, start + chunkSize) - start };
}

async function readJsonSafe(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  try { return text ? JSON.parse(text) : null; } catch { return { error: text.slice(0, 300) || `HTTP ${res.status}` }; }
}

/** POST /api/uploads with retries on 5xx / network; 4xx is the caller's mistake and surfaces at once. */
async function openUploadSession(ctx: Ctx, body: Record<string, unknown>): Promise<UploadSessionReply> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await ctx.api("meetings", "/api/uploads", { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      const data = await readJsonSafe(res);
      if (res.ok && data?.id) return data as UploadSessionReply;
      const msg = data?.error ?? `Upload failed (HTTP ${res.status})`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new UploadFailed(msg, res.status);
      if (attempt >= 8) throw new UploadFailed(msg, res.status);
    } catch (e) {
      if (e instanceof UploadFailed) throw e;
      if (attempt >= 8) throw new UploadFailed(`Upload failed: could not reach the server (${e instanceof Error ? e.message : String(e)})`);
    }
    await sleep(Math.min(BACKOFF_CAP_MS, 1000 * 2 ** (attempt - 1)));
  }
}

/** Chunk mode: PUT every chunk the server has not acknowledged, CHUNK_PARALLELISM at a time, each retried with backoff. */
async function sendMissingChunks(ctx: Ctx, fd: number, size: number, session: UploadSessionReply, progress: UploadProgress): Promise<void> {
  const have = new Set(session.received);
  const queue: number[] = [];
  for (let i = 0; i < session.chunkCount; i++) if (!have.has(i)) queue.push(i);
  let acked = 0;
  for (const i of session.received) acked += chunkRange(size, session.chunkSize, i).length;
  progress.set("Uploading", acked);
  let failure: unknown = null;
  const worker = async () => {
    while (queue.length && !failure) {
      const idx = queue.shift()!;
      const range = chunkRange(size, session.chunkSize, idx);
      const buf = readRange(fd, range.start, range.length);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await ctx.api("meetings", `/api/uploads/${session.id}/chunks/${idx}`, {
            method: "PUT", body: buf,
            headers: { "content-type": "application/octet-stream", "content-length": String(range.length), "x-chunk-sha256": sha256 },
            signal: AbortSignal.timeout(PIECE_TIMEOUT_MS),
          });
          if (res.ok) { await res.text().catch(() => ""); acked += range.length; progress.set("Uploading", acked); break; }
          const data = await readJsonSafe(res);
          if (res.status === 404 || res.status === 410) throw new SessionGone(data?.error ?? "session gone");
          // Auth problems and malformed requests won't fix themselves.
          if ([401, 403, 409, 413].includes(res.status)) throw new UploadFailed(data?.error ?? `chunk ${idx + 1} rejected (HTTP ${res.status})`, res.status);
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        } catch (e) {
          if (e instanceof SessionGone || e instanceof UploadFailed) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt >= MAX_CHUNK_ATTEMPTS) throw new UploadFailed(`Upload failed: chunk ${idx + 1}/${session.chunkCount} did not go through after ${attempt} attempts (${msg}) — re-run the same command to continue from what arrived`);
          progress.note(`Connection hiccup — retrying chunk ${idx + 1}/${session.chunkCount} (attempt ${attempt + 1}): ${msg}`);
          await sleep(Math.min(BACKOFF_CAP_MS, 500 * 2 ** Math.min(attempt, 6)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_PARALLELISM, queue.length || 1) }, () => worker().catch((e) => { failure = failure ?? e; })));
  if (failure) throw failure;
}

// --- Azure Blob REST subset (mirrors src/lib/darth-uploads-shared.ts) ------
const blockIdOf = (index: number) => Buffer.from(String(index).padStart(6, "0"), "binary").toString("base64");
function withQuery(sasUrl: string, extra: Record<string, string>): string {
  const u = new URL(sasUrl);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}
function parseUncommitted(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  const section = /<UncommittedBlocks>([\s\S]*?)<\/UncommittedBlocks>/.exec(xml)?.[1] ?? "";
  for (const m of section.matchAll(/<Block>\s*<Name>([^<]*)<\/Name>\s*<Size>(\d+)<\/Size>\s*<\/Block>/g)) out.set(m[1]!, Number(m[2]));
  return out;
}
const blockListXml = (ids: string[]) => `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join("")}</BlockList>`;

/**
 * Blob mode: every attempt first asks Azure which blocks it already holds
 * (resume), PUTs the rest `ticket.parallel` at a time, then commits the
 * block list. An expired / refused SAS is replaced through `renewTicket`
 * (same blob, fresh signature). Retries inside BLOB_RESUME_WINDOW_MS.
 */
async function uploadBlobBlocks(fd: number, size: number, contentType: string, ticket0: BlobTicket, renewTicket: () => Promise<BlobTicket>, progress: UploadProgress): Promise<void> {
  let ticket = ticket0;
  const blocks: Array<{ index: number; start: number; end: number }> = [];
  for (let i = 0, start = 0; start < size; i++, start += ticket.blockBytes) blocks.push({ index: i, start, end: Math.min(size, start + ticket.blockBytes) });
  const ids = blocks.map((b) => blockIdOf(b.index));
  let attempt = 0;
  let firstFailureAt: number | null = null;
  for (;;) {
    try {
      if (new Date(ticket.expiresAt).getTime() <= Date.now()) ticket = await renewTicket();
      // Already committed (a previous run got past the block list)? Straight to complete.
      const head = await fetch(ticket.sasUrl, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
      if (head.status === 200 && Number(head.headers.get("content-length")) === size) { progress.set("Uploading", size); return; }
      if (head.status === 401 || head.status === 403) throw new BlobFailed("the upload link expired", head.status);
      const listed = await fetch(withQuery(ticket.sasUrl, { comp: "blocklist", blocklisttype: "uncommitted" }), { signal: AbortSignal.timeout(30_000) });
      let have = new Map<string, number>();
      if (listed.status === 200) have = parseUncommitted(await listed.text());
      else if (listed.status === 401 || listed.status === 403) throw new BlobFailed("the upload link expired", listed.status);
      else if (listed.status !== 404) throw new BlobFailed(`block list failed (${listed.status})`, listed.status);
      const done = new Set<number>();
      let acked = 0;
      for (const b of blocks) if (have.get(ids[b.index]!) === b.end - b.start) { done.add(b.index); acked += b.end - b.start; }
      if (acked > 0 && attempt === 0) progress.note(`Resuming — Azure already holds ${fmtMB(acked)} of ${fmtMB(size)} MB (${Math.round((acked / size) * 100)}%)`);
      progress.set("Uploading", acked);
      const pending = blocks.filter((b) => !done.has(b.index));
      let next = 0;
      let failed: unknown = null;
      const worker = async () => {
        while (next < pending.length && !failed) {
          const b = pending[next++]!;
          const body = readRange(fd, b.start, b.end - b.start);
          let res: Response;
          try {
            res = await fetch(withQuery(ticket.sasUrl, { comp: "block", blockid: ids[b.index]! }), {
              method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": String(body.length) }, body, signal: AbortSignal.timeout(PIECE_TIMEOUT_MS),
            });
          } catch (e) {
            throw new BlobFailed(`block ${b.index + 1}/${blocks.length}: ${e instanceof Error ? e.message : String(e)}`, 0);
          }
          if (!(res.status >= 200 && res.status < 300)) throw new BlobFailed(`block ${b.index + 1}/${blocks.length} failed (${res.status})`, res.status);
          await res.text().catch(() => "");
          acked += b.end - b.start;
          progress.set("Uploading", acked);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, ticket.parallel) }, () => worker().catch((e) => { failed = failed ?? e; })));
      if (failed) throw failed;
      const commit = await fetch(withQuery(ticket.sasUrl, { comp: "blocklist" }), {
        method: "PUT", headers: { "content-type": "application/xml", "x-ms-blob-content-type": contentType || "application/octet-stream" }, body: blockListXml(ids), signal: AbortSignal.timeout(60_000),
      });
      if (!(commit.status >= 200 && commit.status < 300)) throw new BlobFailed(`commit failed (${commit.status})`, commit.status);
      await commit.text().catch(() => "");
      return;
    } catch (e) {
      if (e instanceof SessionGone || e instanceof UploadFailed) throw e;
      attempt += 1;
      firstFailureAt = firstFailureAt ?? Date.now();
      const message = e instanceof Error ? e.message : String(e);
      if (Date.now() - firstFailureAt > BLOB_RESUME_WINDOW_MS) throw new UploadFailed(`Upload failed: ${message} — re-run the same command to continue from what arrived`, e instanceof BlobFailed ? e.status || undefined : undefined);
      progress.note(`Connection hiccup — reconnecting (attempt ${attempt + 1}): ${message}`);
      if (e instanceof BlobFailed && (e.status === 401 || e.status === 403)) ticket = await renewTicket();
      await sleep(BLOB_BACKOFF_S[Math.min(BLOB_BACKOFF_S.length - 1, attempt - 1)]! * 1000);
    }
  }
}

type SessionOutcome = { kind: "done"; transcriptId: string } | { kind: "failed"; error: string } | { kind: "open" };

/** GET /api/uploads/:id until a terminal state — finalize can legitimately run for minutes (AAI re-upload of a multi-GB file). */
async function pollUploadSession(ctx: Ctx, id: string): Promise<SessionOutcome> {
  for (let i = 0; i < 400; i++) {
    await sleep(3000);
    try {
      const res = await ctx.api("meetings", `/api/uploads/${id}`, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return { kind: "failed", error: "Upload session vanished" };
      const s = await readJsonSafe(res);
      if (!res.ok || !s) continue;
      if (s.status === "done" && s.transcriptId) return { kind: "done", transcriptId: s.transcriptId };
      if (s.status === "failed") return { kind: "failed", error: s.error ?? "Upload failed" };
      if (s.status === "open") return { kind: "open" };
    } catch { /* network — keep polling */ }
  }
  return { kind: "failed", error: "Upload failed: finalize did not finish" };
}

/** POST …/complete, exactly-once on the server; a lost reply is recovered by polling. */
async function completeUploadSession(ctx: Ctx, id: string, progress: UploadProgress): Promise<{ transcript?: any; transcriptId?: string }> {
  progress.note("Finalizing…");
  for (let attempt = 1; ; attempt++) {
    let lost = false;
    try {
      // No client timeout here: the server answers only once finalize is
      // through (blob pull + AAI ingest), which is minutes for a big file.
      const res = await ctx.api("meetings", `/api/uploads/${id}/complete`, { method: "POST" });
      const body = await readJsonSafe(res);
      if (res.ok) {
        if (body?.transcript) return { transcript: body.transcript };
        if (body?.transcriptId) return { transcriptId: body.transcriptId };
        throw new UploadFailed("Upload finished but the server returned no transcript");
      }
      if (res.status === 409 && body?.status === "completing") lost = true; // an earlier attempt of ours is finalizing — poll
      else if (res.status === 409 && body?.missing) throw new SessionGone(JSON.stringify(body)); // caller re-syncs chunks
      else if (res.status === 409 && body?.notCommitted) throw new NotCommitted(); // caller re-syncs blocks
      else if (res.status === 503) {
        progress.note("Transfer from blob storage hiccuped on the server — retrying…");
        if (attempt >= 20) throw new UploadFailed(body?.error ?? "Upload failed: the server's transfer kept failing", res.status);
      } else if (res.status === 404 || res.status === 410) throw new SessionGone(body?.error ?? "session gone");
      else throw new UploadFailed(body?.error ?? `Upload failed (HTTP ${res.status})`, res.status);
    } catch (e) {
      if (e instanceof UploadFailed || e instanceof SessionGone || e instanceof NotCommitted) throw e;
      lost = true; // network dropped while the server may still be finalizing
    }
    if (lost) {
      const outcome = await pollUploadSession(ctx, id);
      if (outcome.kind === "done") return { transcriptId: outcome.transcriptId };
      if (outcome.kind === "failed") throw new UploadFailed(outcome.error);
      // still 'open' (our complete never reached the server) → retry
    }
    if (attempt >= 20) throw new UploadFailed("Upload failed: could not finalize");
    await sleep(Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.min(attempt, 4)));
  }
}

interface ResumableUploadOpts {
  eventRef?: string;
  languageCode?: string;
  scratch: boolean;
  /** --resume was passed: say so when there is nothing to resume. */
  resumeExpected: boolean;
}

// --- Local session ledger ----------------------------------------------------
// The server resumes by (user, fingerprint) — but only while the session is
// OPEN. A Ctrl-C during "Finalizing…" leaves the server finishing the upload
// on its own (status completing → done): re-running the command then finds
// no open session, opens a fresh one and creates a DUPLICATE transcript. So
// the CLI remembers {fingerprint → session id} in the darth config dir and,
// before opening, asks the server what became of the last session for this
// file: done → that transcript is the answer; completing → poll it; open →
// the normal resume; anything else → start over. Entries expire with the
// server's 24 h session lifetime. Same location convention as
// holocron-leases.json (DARTH_CONFIG_DIR honoured).
const LEDGER_FILE = join(process.env.DARTH_CONFIG_DIR || join(homedir(), ".darth"), "meetings-uploads.json");
const LEDGER_TTL_MS = 24 * 60 * 60_000;
type Ledger = Record<string, { id: string; file: string; size: number; at: string }>;

function readLedger(): Ledger {
  try {
    const raw = JSON.parse(readFileSync(LEDGER_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return {};
    const now = Date.now();
    const out: Ledger = {};
    for (const [k, v] of Object.entries(raw as Ledger)) if (v?.id && v.at && now - Date.parse(v.at) < LEDGER_TTL_MS) out[k] = v;
    return out;
  } catch { return {}; }
}
function writeLedger(mut: (l: Ledger) => void): void {
  try {
    const l = readLedger();
    mut(l);
    mkdirSync(join(LEDGER_FILE, ".."), { recursive: true });
    writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2) + "\n");
  } catch { /* best effort — the server-side resume still works without it */ }
}

/** What the server says about the last session this CLI opened for `fingerprint`, if any. */
async function priorSessionOutcome(ctx: Ctx, fingerprint: string, progress: UploadProgress): Promise<{ transcriptId: string } | null> {
  const prior = readLedger()[fingerprint];
  if (!prior) return null;
  let s: any = null;
  try {
    const res = await ctx.api("meetings", `/api/uploads/${prior.id}`, { signal: AbortSignal.timeout(30_000) });
    s = res.ok ? await readJsonSafe(res) : null;
  } catch { s = null; }
  if (s?.status === "done" && s.transcriptId) {
    progress.note(`The interrupted run already completed on the server (session ${prior.id}) — using its transcript instead of uploading again`);
    return { transcriptId: s.transcriptId };
  }
  if (s?.status === "completing") {
    progress.note(`The interrupted run is still being finalized on the server (session ${prior.id}) — waiting for it instead of uploading again`);
    const outcome = await pollUploadSession(ctx, prior.id);
    if (outcome.kind === "done") return { transcriptId: outcome.transcriptId };
    if (outcome.kind === "failed") throw new UploadFailed(outcome.error);
    return null; // reopened (transient pull failure) → the normal resume path takes it
  }
  if (s?.status !== "open") writeLedger((l) => { delete l[fingerprint]; });
  return null;
}

/**
 * Upload one media file through a resumable session. Resolves with the
 * transcript row (fetched by id when the complete reply only carried the
 * id). Restarts the session once if the server says it is gone.
 */
async function uploadResumable(ctx: Ctx, file: string, name: string, size: number, opts: ResumableUploadOpts, progress: UploadProgress): Promise<{ transcript: any; sessionId: string; via: "chunks" | "blob" | "prior" }> {
  const contentType = mimeFor(name);
  progress.set("Reading", 0);
  const sha256 = await sha256File(file, (n) => progress.set("Reading", n));
  const body: Record<string, unknown> = {
    fingerprint: `cli:v1:${sha256}`, size, filename: name, contentType,
    languageCode: opts.languageCode || undefined, eventRef: opts.eventRef || undefined, scratch: opts.scratch || undefined,
    via: "blob", sha256,
  };
  const fingerprint = body.fingerprint as string;
  const prior = await priorSessionOutcome(ctx, fingerprint, progress);
  if (prior) {
    const priorId = readLedger()[fingerprint]?.id ?? "?";
    writeLedger((l) => { delete l[fingerprint]; });
    return { ...(await resolveDone(ctx, prior)), sessionId: priorId, via: "prior" };
  }
  const fd = openSync(file, "r");
  let sessionId: string | null = null;
  let where = "on the server";
  const onSigint = () => {
    progress.end();
    console.error(sessionId
      ? `\nInterrupted — session ${sessionId} stays resumable for 24 h (${fmtMB(progress.seen)} of ${fmtMB(size)} MB ${where}). Re-run the same command on the same file to continue.`
      : "\nInterrupted before the upload session opened — nothing is on the server yet. Re-run the same command to upload.");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  try {
    let restarts = 0;
    for (;;) {
      const session = await openUploadSession(ctx, body);
      sessionId = session.id;
      writeLedger((l) => { l[fingerprint] = { id: session.id, file: name, size, at: new Date().toISOString() }; });
      const via: "chunks" | "blob" = session.via === "blob" && session.blob ? "blob" : "chunks";
      where = via === "blob" ? "in Azure Blob storage" : "on the server";
      if (session.resumed) progress.note(`Found an open upload session for this file (${session.id}) — resuming`);
      else if (opts.resumeExpected && restarts === 0) progress.note("Nothing to resume for this file (no open upload session on the server) — uploading from the start");
      try {
        if (via === "blob") {
          const renewTicket = async (): Promise<BlobTicket> => {
            const again = await openUploadSession(ctx, body);
            if (again.id !== session.id || again.via !== "blob" || !again.blob) throw new SessionGone("blob session replaced");
            return again.blob;
          };
          for (let sync = 0; sync < 3; sync++) {
            await uploadBlobBlocks(fd, size, contentType, session.blob!, renewTicket, progress);
            try {
              const done = await completeUploadSession(ctx, session.id, progress);
              writeLedger((l) => { delete l[fingerprint]; });
              return { ...(await resolveDone(ctx, done)), sessionId: session.id, via };
            } catch (e) {
              if (e instanceof NotCommitted && sync < 2) continue;
              if (e instanceof NotCommitted) throw new UploadFailed("Upload failed: the blob never committed — re-run the same command");
              throw e;
            }
          }
          throw new UploadFailed("Upload failed: blocks kept going missing");
        }
        if (session.resumed) {
          let bytes = 0;
          for (const i of session.received) bytes += chunkRange(size, session.chunkSize, i).length;
          progress.note(`Resuming — ${fmtMB(bytes)} of ${fmtMB(size)} MB already on the server (${Math.round((bytes / size) * 100)}%)`);
        }
        for (let sync = 0; sync < 3; sync++) {
          await sendMissingChunks(ctx, fd, size, session, progress);
          try {
            const done = await completeUploadSession(ctx, session.id, progress);
            writeLedger((l) => { delete l[fingerprint]; });
            return { ...(await resolveDone(ctx, done)), sessionId: session.id, via };
          } catch (e) {
            if (e instanceof SessionGone && e.message.startsWith("{") && sync < 2) {
              const fresh = await openUploadSession(ctx, body);
              if (fresh.id !== session.id) throw new SessionGone("session replaced");
              session.received = fresh.received;
              continue;
            }
            throw e;
          }
        }
        throw new UploadFailed("Upload failed: chunks kept going missing");
      } catch (e) {
        if (e instanceof SessionGone && restarts < 1) { restarts++; progress.note("Upload session expired on the server — starting over"); continue; }
        if (e instanceof SessionGone) throw new UploadFailed("Upload session expired — please run the upload again");
        throw e;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    closeSync(fd);
    progress.end();
  }
}

async function resolveDone(ctx: Ctx, done: { transcript?: any; transcriptId?: string }): Promise<{ transcript: any }> {
  if (done.transcript) return { transcript: done.transcript };
  const g = await ctx.expectJson<{ transcript: any }>(ctx.api("meetings", `/api/transcripts/${done.transcriptId}`));
  return { transcript: g.transcript };
}

/** '<eventId>|<startIso>' = event key; anything else = meeting code. */
function eventRefBody(ref: string): { eventKey: string } | { meetingCode: string } {
  return ref.includes("|") ? { eventKey: ref } : { meetingCode: ref };
}

/** Parse the 'set-date' argument: ISO 8601 (offset/Z honoured), 'YYYY-MM-DD HH:mm'
 * (machine-local time), or 'YYYY-MM-DD' (local noon, so the day is right in
 * every nearby timezone). */
function parseWhen(raw: string): Date | null {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) { const d = new Date(`${t}T12:00:00`); return Number.isNaN(d.getTime()) ? null : d; }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) { const d = new Date(t.replace(" ", "T")); return Number.isNaN(d.getTime()) ? null : d; }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One line per diarized speaker: confirmed name, else the guess. */
function printSpeakers(id: string, t: any, sp: { speakerLabels: any[]; suggestions: Record<string, any> }): void {
  const labels = new Map<string, any>((sp.speakerLabels || []).map((l: any) => [l.originalSpeaker, l]));
  const names = new Set<string>([...labels.keys(), ...Object.keys(sp.suggestions || {})]);
  const pass = t?.speaker_id_status ?? "not run";
  console.log(`speakers of ${id}  (${t?.speaker_count ?? names.size} diarized · speaker-ID pass: ${pass}${pass === "running" ? " — guesses may still change" : ""})`);
  if (!names.size) { console.log("  (no speaker information yet)"); return; }
  for (const orig of [...names].sort()) {
    const l = labels.get(orig); const g = sp.suggestions?.[orig];
    const confirmed = l?.customName?.trim();
    const guess = g ? `${g.name} (${Math.round((g.confidence ?? 0) * 100)}%${g.source ? `, ${g.source}` : ""}${g.via === "id" ? ", id-pass" : ""})` : null;
    let line = `  ${orig.padEnd(10)} `;
    if (confirmed) line += `= ${confirmed}   [confirmed${guess ? `; guess was ${guess}` : ""}]`;
    else if (guess) line += `? ${guess}${g.evidence ? `  — ${oneLine(String(g.evidence), 140)}` : ""}`;
    else line += "? (no guess)";
    console.log(line);
  }
  if (![...labels.values()].some((l: any) => l?.customName?.trim()))
    console.log("  confirm with: darth-cli meetings set-speakers <id> A=\"Full Name\" B=\"Full Name\"");
}

async function fetchSpeakers(ctx: Ctx, id: string): Promise<{ t: any; sp: any }> {
  const [tr, sp] = await Promise.all([
    ctx.expectJson<{ transcript: any }>(ctx.api("meetings", `/api/transcripts/${id}`)),
    ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${id}/speakers`)),
  ]);
  return { t: tr.transcript, sp };
}

/** Poll a fresh upload until transcription is done, then (briefly) until the
 * speaker-ID pass settles. Returns the final id or null on failure/timeout. */
async function waitForUpload(ctx: Ctx, startId: string, capMin: number, say: (l: string) => void): Promise<{ id: string; t: any } | null> {
  const deadline = Date.now() + capMin * 60_000;
  let id = startId; let t: any = null;
  say(`Waiting for transcription (up to ${capMin} min, poll 10s)…`);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const gr = await ctx.api("meetings", `/api/transcripts/${id}`);
    if (!gr.ok) {
      // Placeholder ids can be renamed on promotion — re-resolve, then retry.
      const rr = await ctx.api("meetings", `/api/meetings/resolve?any=${encodeURIComponent(id)}`);
      const j: any = rr.ok ? await rr.json().catch(() => null) : null;
      if (j?.transcriptId && j.transcriptId !== id) { id = j.transcriptId; say(`… promoted to ${id}`); continue; }
      if (gr.status === 404) { console.error(`Transcript ${id} vanished (upload reaped?) — check the web app.`); return null; }
      continue;
    }
    const gj: any = await gr.json().catch(() => null);
    t = gj?.transcript; const st = t?.status;
    if (st === "error") { console.error(`Transcription failed: ${t?.error ?? "see the web app"}`); return null; }
    if (st !== "completed") continue;
    // Completed. The speaker-ID pass starts right after completion and takes
    // ~1-2 min; give it a bounded window so the caller gets names, not labels.
    say(`Transcribed: ${id}  "${t.title ?? t.original_filename ?? ""}"  (${fmtDuration(t.duration)}, ${t.speaker_count ?? "?"} speakers)`);
    const idDeadline = Math.min(deadline, Date.now() + 4 * 60_000);
    while (Date.now() < idDeadline) {
      const s = t?.speaker_id_status;
      if (s === "completed" || s === "error") break;
      await new Promise((r) => setTimeout(r, 10_000));
      const g2: any = await ctx.expectJson<{ transcript: any }>(ctx.api("meetings", `/api/transcripts/${id}`));
      t = g2.transcript;
    }
    return { id, t };
  }
  console.error(`Still transcribing after ${capMin} min — it keeps running server-side; check later with 'get ${id}'.`);
  return null;
}

async function calendarAll(ctx: Ctx, flags: Record<string, string | boolean>): Promise<number> {
  const fr = readFilterFlags(ctx, flags, ["participant", "organizer", "provider", "q", "from", "to"]);
  if (!fr.ok) { console.error(fr.error); return 1; }
  const q = new URLSearchParams(fr.params);
  const tz = localTz(ctx);
  q.set("tz", tz);
  if (flags.cached === true) q.set("sync", "0");
  const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/calendar/events?${q.toString()}`));
  const details = flags.details === true;
  ctx.print(data, () => {
    const { range, events, counts, sync } = data;
    if (!data.connected) {
      console.error("Google is not connected for this account — connect it in the web app Settings (meetings.darth-internal.trames.io/settings) so the service can read your calendar. Showing the (empty) cache.");
    } else if (sync?.error) {
      console.error(`note: ${sync.error}`);
    }
    if (!events.length) {
      console.log(`No calendar events between ${range.from} and ${range.to} (tz ${tz}).`);
      return;
    }
    let lastDay = "";
    for (const e of events) {
      if (e.day !== lastDay) {
        lastDay = e.day;
        const dow = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${e.day}T00:00:00Z`));
        console.log(`\n${e.day} ${dow}`);
      }
      const time = fmtLocalDateTime(e.start, tz).slice(11);
      const who = e.organizerSelf ? "me" : (e.organizerEmail || "?");
      const cols = [
        `  ${time}`,
        fmtMins(e.durationSecs).padStart(5),
        (e.provider || "-").padEnd(5),
        calendarAllStatus(e).padEnd(22),
        `${e.attendeeCount ?? 0} att`.padStart(7),
        who.padEnd(28),
        e.title || "(untitled)",
      ];
      const imp = e.imported;
      const ai = imp?.accessible
        ? [imp.notes === "ready" ? "notes" : imp.notes === "running" ? "notes…" : null,
           imp.report === "ready" ? "report" : imp.report === "running" ? "report…" : null].filter(Boolean).join("+")
        : "";
      const tail = [
        e.meetingCode ? `[${e.meetingCode}]` : null,
        imp?.accessible ? `→ ${imp.id}${ai ? ` (${ai})` : ""}` : null,
        imp && !imp.accessible && imp.ownerEmail ? `owner ${imp.ownerEmail}` : null,
        e.series ? `series:"${e.series.title}"` : null,
        e.muted ? "(muted)" : null,
      ].filter(Boolean).join("  ");
      console.log(`${cols.join("  ")}${tail ? `  ${tail}` : ""}`);
      if (details) {
        const ind = "            ";
        if (e.location) console.log(`${ind}where: ${oneLine(e.location, 160)}`);
        if (e.attendees?.length) {
          const names = e.attendees.map((a: any) => `${a.email}${a.responseStatus && a.responseStatus !== "accepted" ? ` (${a.responseStatus})` : ""}`);
          console.log(`${ind}with:  ${names.slice(0, 12).join(", ")}${names.length > 12 ? ` +${names.length - 12} more` : ""}`);
        }
        if (e.meetingUrl) console.log(`${ind}link:  ${e.meetingUrl}${imp?.url ? `  (transcript ${imp.url})` : ""}`);
        else if (imp?.url) console.log(`${ind}link:  ${imp.url}`);
        if (e.calendarUrl) console.log(`${ind}gcal:  ${e.calendarUrl}`);
        console.log(`${ind}key:   ${e.key}`);
        if (e.description) console.log(`${ind}about: ${oneLine(e.description, 400)}`);
      }
    }
    const src = sync?.ran ? `live from Google (${sync.fetched} fetched) + cache` : "server cache only";
    console.log(`\n${counts.total} event(s) ${range.from} → ${range.to} (tz ${tz}): ${counts.past} past, ${counts.upcoming} upcoming · ${counts.imported} imported, ${counts.withEvidence} with a recording/transcript at the provider · ${src}${data.truncated ? " · TRUNCATED at 5000 rows — narrow --from/--to" : ""}`);
  });
  return 0;
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
    liftBoolFlags(pos, flags, ["cascade", "exact", "cached", "details", "wait", "clear", "scratch", "resume", CONSENT_FLAG]);
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

      case "offline": {
        const sub = args[0];
        const OFFLINE_KEYS = ["transcripts", "audio", "video"] as const;
        const fmtPrefs = (p: any) => OFFLINE_KEYS.map(k => `${k} ${p?.[k] ?? "?"}`).join(" · ");
        if (sub === "plan") {
          const ids = args.slice(1).flatMap(a => a.split(",")).map(s => s.trim()).filter(Boolean);
          const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/offline/plan${ids.length ? `?ids=${encodeURIComponent(ids.join(","))}` : ""}`));
          ctx.print(data, () => {
            const prefs = data.prefs ?? {};
            const meetings: any[] = data.meetings ?? [];
            // The web app's ladder (src/lib/offline/offline-sync.ts desiredAutoLevels):
            // newest N at transcript; of those with a stored recording the first
            // N at audio; of those with video the first N at video. Max wins.
            const level = new Map<string, string>();
            const rank: Record<string, number> = { transcript: 1, audio: 2, video: 3 };
            const set = (m: any, l: string) => { const cur = level.get(m.id); if (!cur || rank[l]! > rank[cur]!) level.set(m.id, l); };
            const hasVideo = (m: any) => !!(m.media?.isVideo || (m.media?.parts ?? []).some((p: any) => p.isVideo));
            if (!ids.length) {
              for (const m of meetings.slice(0, Math.max(0, prefs.transcripts ?? 0))) set(m, "transcript");
              const withMedia = meetings.filter(m => m.media?.hasLocal);
              for (const m of withMedia.slice(0, Math.max(0, prefs.audio ?? 0))) set(m, "audio");
              for (const m of withMedia.filter(hasVideo).slice(0, Math.max(0, prefs.video ?? 0))) set(m, "video");
            }
            console.log(`offline plan — auto-pin counts: ${fmtPrefs(prefs)}${data.buildId ? `  (build ${data.buildId})` : ""}`);
            if (!meetings.length) { console.log(ids.length ? "None of those meetings is available to you (deleted, unshared, or never yours) — a device unpins them." : "Nothing to keep offline yet (no completed meetings visible to you)."); return; }
            let storedTotal = 0;
            const byLevel: Record<string, number> = {};
            for (const m of meetings) {
              const parts: any[] = m.media?.parts ?? [];
              const stored = parts.reduce((n: number, p: any) => n + (p.bytes ?? 0), 0);
              storedTotal += stored;
              const media = !m.media?.hasLocal ? "no recording" : `${hasVideo(m) ? "video" : "audio"} ${fmtMB(stored)} MB${parts.length > 1 ? ` (${parts.length} parts)` : ""}${parts.some((p: any) => p.bytes == null) ? " (a part is missing on disk)" : ""}`;
              const date = (m.recordedAt || m.createdAt || "").slice(0, 10);
              const lvl = ids.length ? "available" : (level.get(m.id) ?? "-");
              byLevel[lvl] = (byLevel[lvl] ?? 0) + 1;
              console.log(`${m.id}  ${date}  ${fmtDuration(m.durationSec).padStart(7)}  ${lvl.padEnd(10)}  ${media.padEnd(28)}  ${m.title || "(untitled)"}`);
            }
            if (ids.length) {
              const missing = ids.filter(id => !meetings.some(m => m.id === id));
              if (missing.length) console.log(`\nnot available (a device unpins these): ${missing.join(", ")}`);
              console.log(`\n${meetings.length} of ${ids.length} meeting(s) available · stored recordings ${fmtMB(storedTotal)} MB`);
            } else {
              console.log(`\n${meetings.length} meeting(s) in the plan: ${["video", "audio", "transcript"].map(l => `${byLevel[l] ?? 0} at ${l}`).join(", ")} · stored recordings ${fmtMB(storedTotal)} MB (the video tier fetches the stored file; the audio tier a smaller audio-only variant; transcript = page + text only)`);
            }
          });
          return 0;
        }
        if (sub === "prefs") {
          if (flags.set === undefined) {
            const data = await ctx.expectJson<any>(ctx.api("meetings", "/api/offline/prefs"));
            ctx.print(data, () => {
              console.log(`offline auto-pin counts (newest N meetings every device of this account keeps offline):`);
              for (const k of OFFLINE_KEYS) console.log(`  ${k.padEnd(12)} ${String(data.prefs?.[k] ?? "?").padStart(4)}   (default ${data.defaults?.[k] ?? "?"}, max ${data.max?.[k] ?? "?"})`);
              console.log(`change: darth-cli meetings offline prefs --set transcripts=200,audio=20 --${CONSENT_FLAG}`);
            });
            return 0;
          }
          const raw = str(flags.set);
          const patch: Record<string, number> = {};
          for (const pair of (raw ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
            const eq = pair.indexOf("=");
            const k = pair.slice(0, eq).trim(); const v = pair.slice(eq + 1).trim();
            if (eq <= 0 || !(OFFLINE_KEYS as readonly string[]).includes(k) || !/^\d+$/.test(v)) {
              console.error(`--set takes <key>=<count> pairs, comma-separated; keys: ${OFFLINE_KEYS.join(", ")} (got '${pair}')`);
              return 1;
            }
            patch[k] = Number(v);
          }
          if (!Object.keys(patch).length) { console.error(`usage: darth-cli meetings offline prefs --set <key>=<count>[,…]   keys: ${OFFLINE_KEYS.join(", ")}`); return 1; }
          ctx.requireWrite();
          if (!requireConsent(flags, "the offline auto-pin counts")) return 1;
          const data = await ctx.expectJson<any>(ctx.api("meetings", "/api/offline/prefs", { method: "PUT", body: JSON.stringify(patch) }));
          ctx.print(data, () => console.log(`offline auto-pin counts: ${fmtPrefs(data.prefs)}  (values above the cap are clamped: max ${fmtPrefs(data.max)})`));
          return 0;
        }
        console.error("usage: darth-cli meetings offline plan [<id,…>] | offline prefs [--set <key>=<count>[,…]]");
        return 1;
      }

      case "whoami": {
        const data = await ctx.expectJson<any>(ctx.api("meetings", "/api/whoami"));
        ctx.print(data, () =>
          console.log(`${data.email} (${data.userId}) via ${data.via}${data.scope ? `, meetings scope: ${data.scope}` : ""}`));
        return 0;
      }

      case "list": {
        if (flags.scratch === true) {
          // Temporary rows only — legacy shape like ?trash=1, nothing else
          // composes (the server ignores filters on this path, so refuse
          // them here instead of silently listing everything).
          const other = [...ALL_FILTER_FLAGS, "label", "exact"].filter(f => flags[f] !== undefined);
          if (other.length) { console.error(`--scratch lists your temporary transcripts only — it does not combine with ${other.map(f => `--${f}`).join(", ")}`); return 1; }
          const data = await ctx.expectJson<{ transcripts: any[] }>(ctx.api("meetings", "/api/transcripts?scratch=1"));
          const rows = data.transcripts;
          ctx.print(rows, () => {
            if (!rows.length) return console.log("No temporary (scratch) transcripts — 'upload --scratch' creates one.");
            printTranscriptRows(rows);
            console.log(`\n${rows.length} temporary transcript(s) — trashed 30 days after creation unless kept in the web UI or linked ('link <id> <ref>')`);
          });
          return 0;
        }
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
          if (t.scratch === true) console.log(`scratch:     yes  (temporary — trashed 30 days after creation unless kept in the web UI or linked)`);
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
        if (view === "all" || view === "full") return calendarAll(ctx, flags);
        for (const f of ["cached", "details"]) if (flags[f] !== undefined) { console.error(`--${f} only applies to --view all`); return 1; }
        if (view !== "unimported" && view !== "norec") { console.error("--view must be unimported, norec or all"); return 1; }
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

      case "upload": {
        const file = args[0];
        if (!file) { console.error("usage: darth-cli meetings upload <file> [--event <meeting-code|event-key>] [--title <t>] [--language <code>] [--scratch] [--wait] [--timeout <mins>]"); return 1; }
        if (!existsSync(file) || !statSync(file).isFile()) { console.error(`No such file: ${file}`); return 1; }
        // No --report here on purpose: the CLI never starts the service's AI
        // runs (a detailed report is a human's web-UI ask); the caller's own
        // agent writes reports via set-report.
        if (flags.report !== undefined) { console.error("--report is not a CLI option: uploads get the default summary notes; a detailed report is requested by a human in the web UI, or written by you with 'set-report'."); return 1; }
        ctx.requireWrite();
        const capMin = Number(str(flags.timeout) ?? "60");
        if (!Number.isFinite(capMin) || capMin <= 0) { console.error(`--timeout must be a number of minutes (got '${str(flags.timeout)}')`); return 1; }
        const name = basename(file); const size = statSync(file).size;
        if (size === 0) { console.error("File is empty"); return 1; }
        const isText = TEXT_DOC_RE.test(name);
        const q = new URLSearchParams();
        const ev = str(flags.event);
        if (ev) q.set("event", ev);
        const lang = str(flags.language);
        if (lang) q.set("language_code", lang);
        // Temporary row: sent even alongside --event — the server decides
        // whether a linked upload can be scratch.
        const scratch = flags.scratch === true;
        if (scratch) q.set("scratch", "1");
        const say = (line: string) => { if (!ctx.json) console.log(line); };
        const eventTip = () => console.error("Tip: 'darth-cli meetings calendar --view all --json' lists your events with their [meeting-code] and exact 'key'.");
        const resumable = !isText && size > ONE_SHOT_MAX_BYTES;
        if (flags.resume === true && !resumable) console.error(`--resume: ${isText ? "text documents" : "files of 8 MB or less"} go up in one request — nothing to resume, uploading normally.`);
        let data: any;
        if (resumable) {
          // Session path (POST /api/uploads): hashed, parallel verified
          // pieces, resumable for 24 h by re-running the same command.
          say(`Uploading ${name} (${fmtMB(size)} MB, resumable)${ev ? ` → event ${ev}` : " unlinked"}${scratch ? " as a temporary (scratch) transcript" : ""}…`);
          try {
            const r = await uploadResumable(ctx, file, name, size, { eventRef: ev, languageCode: lang, scratch, resumeExpected: flags.resume === true }, new UploadProgress(!ctx.json, size));
            data = { transcript: r.transcript };
            say(r.via === "prior"
              ? `Already received by the server in the interrupted run — session ${r.sessionId} (nothing re-uploaded)`
              : `Received via ${r.via === "blob" ? "Azure Blob (pulled by the server)" : "chunks"} — session ${r.sessionId}`);
          } catch (e) {
            if (!(e instanceof UploadFailed)) throw e;
            console.error(`Upload failed${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}`);
            if (e.status === 404 && ev) eventTip();
            return 1;
          }
        } else {
          // Bun streams a Bun.file body (multi-GB safe); node fallback reads it whole.
          const B: any = (globalThis as any).Bun;
          const body: any = B?.file ? B.file(file) : new Blob([readFileSync(file)]);
          say(`Uploading ${name} (${fmtMB(size)} MB)${ev ? ` → event ${ev}` : " unlinked"}${scratch ? " as a temporary (scratch) transcript" : ""}…`);
          const path = isText ? `/api/transcripts/import-text?${q}` : `/api/transcripts?${q}`;
          const res = await ctx.api("meetings", path, {
            method: "POST", body,
            headers: { "content-type": mimeFor(name), "x-filename": encodeURIComponent(name), "content-length": String(size) },
          });
          data = await res.json().catch(() => null);
          if (!res.ok) {
            console.error(`Upload failed (HTTP ${res.status}): ${data?.error ?? "unknown error"}${data?.detail ? ` — ${data.detail}` : ""}`);
            if (res.status === 404 && ev) eventTip();
            return 1;
          }
        }
        // Text importer, unknown format → 202 {queued, id, assemblyaiId}: an
        // LLM normalizes it behind a placeholder row (minutes). Read the
        // placeholder so the printout has a status like the 201 path.
        let t: any = data.transcript;
        let id: string = t?.assemblyai_id ?? data.assemblyaiId;
        if (!t && id) {
          const g: any = await ctx.expectJson<{ transcript: any }>(ctx.api("meetings", `/api/transcripts/${id}`));
          t = g.transcript;
        }
        if (!id) { console.error(`Unexpected reply: ${JSON.stringify(data).slice(0, 300)}`); return 1; }
        const title = str(flags.title);
        if (title && id) {
          await ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }));
          t = { ...t, title };
        }
        const linked = t?.gmeet_context?.eventTitle || t?.gmeet_context?.eventId;
        const isScratch = t?.scratch === true || (scratch && t?.scratch === undefined);
        say(`${data.queued ? "Queued (text normalizing via LLM)" : isText ? "Imported" : "Uploaded"}: ${id}  "${t?.title ?? t?.original_filename ?? ""}"  status: ${t?.status}${linked ? `  linked to "${t.gmeet_context.eventTitle ?? t.gmeet_context.eventId}"` : "  (not linked to any calendar event)"}${isScratch ? "  temporary (scratch): trashed in 30 days unless kept or linked" : ""}`);
        say(`Web: ${webBase(ctx)}/transcript/${id}`);
        if (flags.wait === true && t?.status !== "completed") {
          const done = await waitForUpload(ctx, id, capMin, say);
          if (!done) return 1;
          id = done.id; t = done.t;
          if (!ctx.json) {
            const sp = await ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${id}/speakers`));
            printSpeakers(id, t, sp);
            if (!linked) console.log(`Not linked to a calendar event yet — see 'darth-cli meetings skill' (§ "Someone hands you a recording") for the link / set-date flow.`);
          }
        }
        ctx.print({ transcript: t, linked: !!linked, scratch: isScratch, url: `${webBase(ctx)}/transcript/${id}` }, () => {});
        return 0;
      }

      case "link": {
        const [id, ref] = args;
        if (!id || !ref) { console.error("usage: darth-cli meetings link <id> <meeting-code|event-key>   (key = the 'key' field of 'calendar --view all --json' / --details)"); return 1; }
        ctx.requireWrite();
        const res = await ctx.api("meetings", `/api/transcripts/${id}/link-event`, { method: "POST", body: JSON.stringify(eventRefBody(ref)) });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
          console.error(`Link failed (HTTP ${res.status}): ${data?.error ?? "unknown error"}`);
          if (res.status === 404) console.error("Tip: 'darth-cli meetings calendar --view all --json' lists your events with their [meeting-code] and exact 'key'; a meeting code resolves to its latest PAST occurrence — use the key for an older one.");
          return 1;
        }
        const e = data.event ?? {};
        ctx.print(data, () => {
          const when = e.startTime ? fmtLocalDateTime(e.startTime, localTz(ctx)) : "?";
          console.log(`Linked ${data.transcript?.assemblyai_id ?? id} → "${e.title ?? "(untitled)"}"  ${when}  (${e.provider ?? "no meeting link"}, ${e.attendees ?? 0} attendees${e.enriched ? ", Meet participants captured" : ""})`);
          console.log(`Date set to the event start; title ${data.transcript?.title ? `"${data.transcript.title}"` : "(empty)"}; invitees now appear as share suggestions in the web UI.`);
          if (data.reguessing) console.log(`Re-guessing speaker names with the attendee list — 'darth-cli meetings speakers ${id}' in a minute or two.`);
        });
        return 0;
      }

      case "set-date": {
        const [id, ...rest] = args;
        const raw = rest.join(" ").trim();
        if (!id || !raw) { console.error("usage: darth-cli meetings set-date <id> <ISO-8601 | 'YYYY-MM-DD HH:mm' | YYYY-MM-DD>"); return 1; }
        const when = parseWhen(raw);
        if (!when) { console.error(`Cannot parse '${raw}' — use ISO 8601 (2026-09-15T14:00:00+08:00), 'YYYY-MM-DD HH:mm' (local) or YYYY-MM-DD`); return 1; }
        ctx.requireWrite();
        const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${id}`, { method: "PATCH", body: JSON.stringify({ recordedAt: when.toISOString() }) }));
        ctx.print(data, () => console.log(`Date set: ${fmtLocalDateTime(when.toISOString(), localTz(ctx))} (${when.toISOString()})`));
        return 0;
      }

      case "speakers": {
        const id = args[0];
        if (!id) { console.error("usage: darth-cli meetings speakers <id>"); return 1; }
        const { t, sp } = await fetchSpeakers(ctx, id);
        ctx.print({ speaker_id_status: t?.speaker_id_status ?? null, speaker_count: t?.speaker_count ?? null, ...sp }, () => printSpeakers(id, t, sp));
        return 0;
      }

      case "set-speakers": {
        const [id, ...pairs] = args;
        if (!id || (!pairs.length && flags.clear !== true)) { console.error("usage: darth-cli meetings set-speakers <id> <Speaker>=<Name> [...]  [--clear]   e.g. A=\"Jane Doe\" B=\"Wei Lin\""); return 1; }
        ctx.requireWrite();
        const parsed: Array<{ originalSpeaker: string; customName: string }> = [];
        for (const p of pairs) {
          const eq = p.indexOf("=");
          if (eq <= 0) { console.error(`bad assignment '${p}' — expected <Speaker>=<Name>`); return 1; }
          parsed.push({ originalSpeaker: p.slice(0, eq).trim(), customName: p.slice(eq + 1).trim() });
        }
        const cur = await ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${id}/speakers`));
        const byOrig = new Map<string, any>();
        if (flags.clear !== true) for (const l of cur.speakerLabels || []) byOrig.set(l.originalSpeaker, { ...l });
        for (const a of parsed) byOrig.set(a.originalSpeaker, { originalSpeaker: a.originalSpeaker, customName: a.customName, description: byOrig.get(a.originalSpeaker)?.description ?? "" });
        const speakerLabels = [...byOrig.values()].filter((l) => l.customName || l.description);
        const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${id}/speakers`, { method: "PUT", body: JSON.stringify({ speakerLabels }) }));
        ctx.print(data, () => {
          for (const l of data.speakerLabels || []) if (l.customName) console.log(`  ${String(l.originalSpeaker).padEnd(10)} = ${l.customName}`);
          console.log(`${(data.speakerLabels || []).filter((l: any) => l.customName).length} speaker(s) confirmed — 'text ${id}' now uses these names; voiceprints enrol in the background.`);
        });
        return 0;
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

      case "trash":
      case "restore": {
        const id = args[0];
        if (!id || args.length > 1) { console.error(`usage: darth-cli meetings ${cmd} <id>`); return 1; }
        ctx.requireWrite();
        // DELETE /api/transcripts/:id is a SOFT delete for a live row (the
        // server only deletes for good on ?permanent=1, on a row already in
        // the trash, or on an upload placeholder). The CLI never sends
        // ?permanent=1 — permanent deletion stays a web-UI action — and
        // refuses to DELETE a row the server reports as already trashed,
        // since that second DELETE would be the permanent one.
        if (cmd === "trash") {
          const cur = await ctx.expectJson<{ transcript: any }>(ctx.api("meetings", `/api/transcripts/${id}`));
          const t = cur.transcript;
          if (t?.access !== "owner") { console.error(`Only the owner can trash ${id} (your access: ${t?.access ?? "?"}).`); return 1; }
          if (t?.deleted_at) { console.error(`${id} is already in the trash — 'darth-cli meetings restore ${id}' brings it back; permanent delete is web-only.`); return 1; }
          if (t?.status === "uploading" || t?.status === "waiting") { console.error(`${id} is a placeholder (status ${t.status}) — the server would delete it for good, not trash it. Use the web UI if that is what you want.`); return 1; }
        }
        const res = await ctx.api("meetings", cmd === "trash" ? `/api/transcripts/${id}` : `/api/transcripts/${id}/restore`, { method: cmd === "trash" ? "DELETE" : "POST" });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
          const msg = data?.error ?? `HTTP ${res.status}`;
          if (res.status === 404) console.error(`No transcript ${id} visible to you (${msg}).`);
          else if (res.status === 403) console.error(`${msg} (${id}) — ask its owner.`);
          else if (res.status === 409) console.error(`${id} is not in the trash (${msg}) — nothing to restore.`);
          else console.error(`${cmd} failed (HTTP ${res.status}): ${msg}`);
          return res.status === 401 ? 3 : 1;
        }
        if (cmd === "trash" && data?.trashed !== true) {
          // Should not happen given the pre-check, but never report a soft
          // delete the server did not confirm.
          console.error(`Server deleted ${id} outright (no 'trashed' flag) — it is gone, not in the trash.`);
          ctx.print(data, () => {});
          return 1;
        }
        ctx.print({ ...data, id, action: cmd }, () =>
          console.log(cmd === "trash"
            ? `trashed ${id} — restore with 'darth-cli meetings restore ${id}'`
            : `restored ${id} — back in the listing for everyone it is shared with`));
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
