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
                                  other filters (legacy shape). Serves
                                  LEGACY temporary rows only: new temporary
                                  uploads are recordings → 'recordings list
                                  --temporary'
  get <id>                        One transcript's metadata + AI-notes/report status
                                  ('scratch: yes' marks a temporary row), its
                                  owner and a 'shared with:' line (--json:
                                  "shared_with": [{email,name,access,source,
                                  shared_at,shared_by}])
  text <id> [--index]             Full transcript as "[mm:ss] Speaker: …" lines
                                  (confirmed speaker names applied; grep/regex this).
                                  --index prefixes each line with its 0-based
                                  utterance index, "[12] [mm:ss] Speaker: …" —
                                  the address 'edit-line <id> <n>' takes
  text <id> --version <tid>       The same for a version that is NOT active (see
                                  TRANSCRIPTION VERSIONS); lines whose words came
                                  from a merge's fill pass end with ⟨merged⟩
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
  calendar --view all [--from D] [--to D] [--details] [--cached] [--calendar <email|id>]... [FILTERS except --speaker]
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
                                  has it all always.
                                  --calendar alice@trames.sg also reads a
                                  calendar shared with you (repeatable or
                                  comma list, max 5); the person's email is
                                  the id; needs at least free/busy sharing.
                                  Their rows are tagged cal:<name>
  calendar hidden                 The calendar rows you hid (the listing's
                                  "Hidden (n)"): kind (occurrence | series),
                                  when you hid it, title, and the value
                                  'calendar unhide' takes
  audio <id> [--out <file>]       Download the recording (default ./<id>.<ext>)
  frame <id> <ts> [--out <file>]  Grab a video frame at a timestamp (ms, mm:ss or
                                  hh:mm:ss) as jpeg — only transcripts imported
                                  from a video recording have frames
  speakers <id> [--guess]         Diarized speakers of a transcript: confirmed
                                  name (if a human set one) + the machine's
                                  guess (name, confidence, voice|context) +
                                  the speaker-ID pass status. --guess = the
                                  page's "Guess names" first: a voiceprint match
                                  now (no LLM), and the server restarts the
                                  speaker-ID pass when it errored or never ran
                                  (needs edit access; completed + stored audio)
  attachments <id>                List attached context files
  attachment-get <id> <attId> [--out <file>]   Download one attachment
  activity <id> [--limit N]       The meeting's activity feed, newest first: when
                                  (your tz), who, what (view, edit_meta,
                                  find_replace, share_add, …) + details; and
                                  who viewed it in the last 30 days. N 1-200,
                                  default 50
  ai-runs <id>                    The server's AI runs on this meeting (summary,
                                  report, speaker-ID, …): when, kind, status,
                                  model, cost, duration, tokens, who started it;
                                  plus lifetime totals
  labels                          Org-wide label tree with visible-to-you counts
                                  (subtree-inclusive) and #ids; --json = flat rows
  series                          The curated series YOU can see (you own, edit
                                  or follow them; auditors: all): id, title,
                                  owner, patterns, default labels, followers,
                                  auto-import, how many of its meetings YOU
                                  can open
  series <id>                     One series: owner, editors, description,
                                  patterns, labels, followers, auto-import,
                                  members you can open (404 = not yours to see)
  series preview --pattern <regex> [--pattern …] [--invite-all a@x,b@y]
             [--series <id>]      What these patterns would catch among the
                                  meetings YOU can open — or, with --series of
                                  a series you own/edit, among the meetings
                                  its OWNER can open. Changes nothing
  series occurrences <id> [--refresh]
                                  The series dialog's occurrence list: every
                                  occurrence on YOUR calendar, newest first,
                                  in your tz — imported → <meeting id> (or
                                  "no access" / queued / failed), importable
                                  (recording / transcript at the provider),
                                  nothing recorded, or upcoming. The Google /
                                  Microsoft sweep is cached ~6 h; --refresh
                                  re-sweeps now (can take a minute)
  notify                          Your Slack DM notification switches, one
                                  line per kind (opt-out: on unless turned off)
  reminders                       The home page's reminders card: id, when,
                                  provider, why (not imported / colleagues
                                  need your import / auto-record is off),
                                  title [meeting-code]. With account auto-
                                  sync on, "not imported" rows are not shown
  vocab [--org]                   Your transcription vocabulary (--org = the
                                  company-wide one): one term per line, then
                                  one custom spelling per line as
                                  'To <- from, from'. The output is exactly
                                  what 'vocab --set' reads back
  offline plan [<id,…>]           What the web app keeps offline for you under
                                  the auto-pin counts (newest N: transcript
                                  → audio → video ladder) with the stored
                                  recording sizes; with ids: exactly those
                                  meetings (absent = no longer available)
  offline prefs                   Your offline auto-pin counts (transcripts /
                                  audio / video) with defaults and caps

RECORDINGS (yours only, never shared — see 'darth-cli meetings recordings')
  recordings list|get|text|audio|link|make-meeting|keep|dismiss|rm
  recordings transcriptions|transcribe-again|merge-transcriptions|use-transcription
                                  Your private recordings that belong to no
                                  meeting (unlinked uploads, temporary ones,
                                  Darth Recorder files still on a Mac). A
                                  recording is never shared: link it to an
                                  event (the MEETING it makes is shared with
                                  the invite's Trames colleagues) or make a
                                  meeting of it, then share the MEETING
                                  ('share <meeting-id> --add <email>')

SEGMENTS (a meeting is a TIMELINE of segments — see 'darth-cli meetings segments')
  segments <meeting>              The timeline: each segment = a window of one
                                  recording placed at a time, with a text
                                  policy; plus holes, siblings, what you may do
  segments add|edit|rm|candidates|propose|align
                                  Add a window of YOUR recording to a meeting
                                  ("this recording, 12:40 → 41:05, at 0:00"),
                                  move/trim/re-policy it, remove it, list what
                                  you could add, ask for split proposals,
                                  measure the offset between two recordings
  split <meeting> --from T --to T [--title "…"] [--event <ref>] [--keep-in-both] [--no-wait]
                                  Make that window of the meeting a meeting of
                                  its own on the SAME recording — no file cut,
                                  no re-transcription; the source keeps a hole
                                  there (or both keep it with --keep-in-both).
                                  --event links + shares the new meeting like
                                  'link' does. T = mm:ss, h:mm:ss or ms.
                                  While the speaker-ID pass still runs on the
                                  meeting the server refuses (409
                                  speaker_check_running); the CLI retries every
                                  10 s for up to 3 min — --no-wait fails at once
  unsplit <split-off-id>          Put a split-off meeting back into its source

TRANSCRIPTION VERSIONS (one recording, several transcriptions; ▶ = the one the
meeting shows — mixed-language calls: 'darth-cli meetings skill' → "Mixed-
language recordings")
  transcriptions <id>             Every version, newest first: ▶ active, the
                                  provider/model that actually ran, language
                                  (detected + confidence | forced | merged),
                                  ASR confidence, speakers, status, merge
                                  info, reason; a run in flight; then a HEALTH
                                  line for the active version and, when it
                                  looks mixed-language, the exact command to
                                  run next
  transcribe-again <id> [--language <code|auto|auto-en>] [--model <m>]
         [--reason "…"] [--keep-active | --merge] [--merge-threshold 0.75]
         [--force] [--wait [--timeout <mins>]]
                                  Run another transcription of the recording.
                                  Default: it REPLACES the active version when
                                  done (the fix for a call in ONE language
                                  that was detected wrong). --keep-active =
                                  keep it as a helper (not active). --merge =
                                  merge it with the active version (English =
                                  the base, the other language fills its
                                  low-confidence spans) and activate the merge
                                  — the one-shot fix for a mixed call:
                                    English detected: --language id --merge
                                    other detected:   --language auto-en --merge
                                  auto-en = English base pass that keeps the
                                  other language's speech. NEVER --language
                                  alone on a mixed call: forced en DROPS the
                                  other language's speech, a forced other
                                  language TRANSLATES the English. --force =
                                  repeat the active version's model+language.
                                  --wait polls every 10 s until the run is
                                  done (default cap 30 min), prints the
                                  versions + HEALTH; exit 0 completed, 1
                                  error (or no merge made), 3 timeout (still
                                  running server-side). ~$0.17/h per pass
  merge-transcriptions <id> --base <tid> --fill <tid> [--threshold 0.75]
         [--reason "…"] [--dry-run] [--activate]
                                  Merge two completed versions you already
                                  have (no new transcription): base keeps
                                  speakers/turns, fill's words replace base
                                  spans whose confidence is < --threshold.
                                  --dry-run = stats + before/after preview,
                                  nothing written; --activate = switch to the
                                  merged version at once. Server warnings
                                  (e.g. "base is not an English version") are
                                  printed as WARNING lines
  use-transcription <id> <tid>    Make <tid> the active version (speaker names
                                  and edits of the version left are set aside
                                  and come back when you switch back)
  (write verbs need read+write and EDIT access to the meeting)

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
  label-color <label> <#rrggbb|none>
                                  Change a label's color (the rail's color
                                  dot); none = "No color (inherit parent)".
                                  Quote '#…' or drop the # (the shell reads
                                  an unquoted # as a comment)
  label-rename <label> <newName>  Rename one segment (sub-label paths follow)
  label-mv <label> <newParent|/>  Move a label (and its subtree) under another
                                  label, or '/' = top level
  label-rm <label> [--cascade]    Delete a label; refuses (exit 1) if it has
                                  sub-labels unless --cascade. Assignments on
                                  meetings go with it

WRITE (needs read+write for meetings)
  upload <file> [--event <meeting-code|event-key>] [--separate] [--title <t>]
         [--language <code>] [--scratch] [--resume] [--wait] [--timeout <mins>]
                                  Upload a recording (audio/video; text docs
                                  like .vtt/.txt/.docx go through the text
                                  importer) and transcribe it. --event links
                                  it to a calendar event up front (title,
                                  date, attendees; the meeting is shared
                                  with the invite's Trames colleagues, as
                                  a Meet/Teams import is). If you can
                                  already open a meeting of that
                                  occurrence (a colleague linked theirs),
                                  the upload JOINS it as another recording
                                  instead of making a second meeting —
                                  --separate makes one of its own anyway;
                                  without it the row is unlinked and you can
                                  'link' it later — same single transcription
                                  run either way. (Once the server runs
                                  born-bare uploads, an upload without
                                  --event is a private RECORDING instead:
                                  it prints the recording id, is not in
                                  'list', and you 'recordings link' it.) --scratch = temporary: kept
                                  out of everyone's main archive ('list
                                  --scratch' / the web UI's Temporary tab)
                                  and trashed 30 days after creation unless
                                  kept in the web UI or linked. --wait polls
                                  until transcription AND the speaker-ID
                                  guess finish, then prints 'speakers'.
                                  Uploads generate nothing by themselves — a
                                  run (summary + detailed report, always both)
                                  is started with 'generate' or in the web UI.
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
  link <id> <meeting-code|event-key> [--separate]
                                  Attach an existing transcript (typically an
                                  unlinked upload) to a calendar event: sets
                                  date + empty title + attendees, shares it
                                  with the invite's Trames colleagues (as a
                                  Meet/Teams import does), and re-runs the speaker
                                  guess with the attendee list unless a human
                                  already confirmed names. Metadata only —
                                  nothing is re-transcribed. If <id> is just
                                  one of your recordings and you can already
                                  open a meeting of that occurrence, it is
                                  FOLDED into that meeting (this one goes
                                  to your trash); --separate keeps it apart.
                                  link <id> --dismiss = the suggested-event
                                  strip's "Not this": the guessed event is
                                  no longer offered (409 when there is none)
  set-date <id> <when>            Set the meeting date/time of a transcript
                                  (ISO 8601, 'YYYY-MM-DD HH:mm' in your tz,
                                  or 'YYYY-MM-DD' = noon). For recordings
                                  that match no calendar event
  generate <id> [--instructions "…"] [--no-video] [--run-at <iso|tonight>] [--yes]
                                  The web UI's "Generate / Regenerate summary &
                                  report" — ONE run writes both tiers (quick
                                  summary + detailed report), like the dialog.
                                  Without --yes it only prints the plan (what
                                  would run, with which options). --no-video
                                  = text-only report even when the recording
                                  has video; --run-at schedules it ('tonight'
                                  = the next 02:00 local, or an ISO instant,
                                  max 30 days out). 'regenerate' is an alias.
                                  generate <id> --cancel drops a scheduled or
                                  queued run (a run in flight is not touched)
  hold <id>                       Stop the AUTOMATIC summary of a manual upload
                                  (the "Summary starts automatically at HH:MM"
                                  line): the review gate stays until a human
                                  generates. 409 once it already ran
  add-person "<Name>" <email>     The "+ Person" dialog: add someone to the
                                  people directory so they can be a speaker
                                  with an identity. An email that already
                                  belongs to someone prints that record
                                  instead (nothing is forked)
  help [<verb>]                   This text, or just one verb's lines
  set-speakers <id> <Speaker>=<Name|email|"Name <email>"> ... [--clear] [--from-invite [--yes]]
                                  Confirm who each speaker IS. 'A="Jane Doe"'
                                  = a name; 'A=jane@x.com' = the PERSON (the
                                  server fills the canonical name from the
                                  directory / invite); 'A="Jane Doe <jane@x>"'
                                  = both. Names apply to 'text' output and
                                  enrol the person's voiceprint. Others keep
                                  their current label; '--clear' unsets all
                                  first. --from-invite confirms every guess
                                  that names ONE invitee (table first; --yes
                                  writes). Prints 'name <email>' as stored
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
  series create --title <t> [--description <d>] [--pattern <regex>]…
             [--invite-all a@x,b@y [--invite-any …] [--internal-only]
              [--recurring-only] [--max-people N]] [--label <path>]…
             [--priority N] [--follower <email>]… [--from <transcript-id>]
                                  A curated series: every meeting whose calendar
                                  title matches ANY --pattern (case-insensitive
                                  JS regex) joins it and gets every --label
                                  (missing label paths are created). Anyone can
                                  create; YOU own it, so it matches only the
                                  meetings you can open (an auditor: every
                                  meeting), and followers get only the ones you
                                  own or edit
  series set <id> [--title <t>] [--description <d>] [--notes <md>]
             [--pattern <regex>]… [--clear-patterns] [--label <path>]…
             [--clear-labels] [--priority N]
             [--auto-import on|off] [--mode transcript|video|both]
             [--report detailed-video|detailed-text|later]
                                  Edit a series (owner + editors). --pattern
                                  REPLACES all its patterns, --label REPLACES
                                  its default labels; priority = display order.
                                  Auto-import on = future occurrences import on
                                  their own under YOUR Google link
  series follow <id> <email> [--name <n>]   Owner/editors: <email> gets a
                                  read share of every meeting in the series
                                  the OWNER owns or edits (auditor series: all),
                                  past and future
  series unfollow <id> <email>    Owner/editors: anyone; a follower: themselves
  series editors add|rm <id> <email> [--name <n>]   Owner/editors manage who
                                  may edit (an auditor series: auditors only);
                                  an editor may rm themselves
  series transfer <id> <email>    Owner only: hand the series to <email> (they
                                  must have opened Darth Meetings); you stay
                                  on as an editor. Its reach becomes THEIRS
  series delete <id>              Delete a series (its owner). The meetings stay
  series attach <id> <transcript-id>   Put a meeting the series' owner can open
                                  in a series you own or edit, by hand (stays
                                  even when its patterns stop matching)
  series detach <id> <transcript-id> [--remember]   Take it out of THAT series;
                                  --remember = "not this series" (the patterns
                                  never pull it back)
  auto-sync                       Your account-level auto-sync switch + what it
                                  did recently (imports de-duplicated company-
                                  wide: one import per meeting, others shared in)
  auto-sync explain <meeting-code|uuid> [--start <iso>]
                                  What automation WILL do with one occurrence
                                  and what it DID: owner (series setting vs
                                  account auto-sync vs nobody + why), importer,
                                  mode, effective report (strongest ask across
                                  everyone in it), watchers, ledger row. The
                                  answer to "why wasn't this auto-imported".
                                  Start defaults to the
                                  latest past occurrence of that code
  auto-sync off|mine|all [--mode transcript|video|both]
             [--report detailed-video|detailed-text|later]
             [--gmeet on|off] [--teams on|off]
                                  mine = meetings you organise, all = every
                                  meeting you attend (recommended: all, video,
                                  detailed-video — the defaults); only meetings
                                  that start after you switch it on. Needs
                                  Google connected
  notify <kind> on|off            Flip one Slack DM notification kind (see
                                  'notify' for the kinds)
  vocab [--org] --set --file <path|->
                                  REPLACE your vocabulary (--org: the company
                                  one, versioned) — read it first, edit,
                                  write it back. The file is the text
                                  'vocab' prints (one term per line; 'To <-
                                  from, from' = a spelling; # lines skipped)
                                  or JSON {keyterms_prompt:[…],
                                  custom_spelling:[{to,from:[…]}]}. A
                                  settings write: needs --consent (below)
  reminders dismiss <id>          The card's ✕: this occurrence only
  reminders mute <id>             The card's bell: never remind about this
                                  meeting again (the sync dialog's mute)
  calendar hide <event-key> [--series] [--title "<t>"]
                                  The calendar row's "Hide this occurrence";
                                  --series = "Hide all occurrences + future
                                  ones" (recurring events only). Hides it in
                                  both calendar views, for you only.
                                  <event-key> = the key: line of 'calendar
                                  --view all --details'; --title overrides
                                  the stored title
  calendar unhide <event-key|value> [--series]
                                  Unhide — an occurrence by its key, a series
                                  by any of its keys or by the value
                                  'calendar hidden' prints
  calendar check <event-key> [--teams]
                                  The row's "At Google / Microsoft — check":
                                  asks the provider (your own Google link;
                                  Teams: app-only Graph + the meeting chat)
                                  whether the call left a recording or
                                  transcript, writes the answer back, and
                                  prints it (importable → the 'import'
                                  command). Teams rows are told apart by
                                  the row's provider; --teams forces the
                                  Teams check. Exit 1 when the provider did
                                  not answer
  offline prefs --set <k>=<n>[,<k>=<n>…]
                                  Change the offline auto-pin counts
                                  (transcripts / audio / video; capped
                                  server-side). Applies to every device of
                                  this account
  share <id>[,<id>…] [<id> …] [--add <email>]… [--remove <email>]… [--access edit|read]
                                  Who has access to a meeting, and changing
                                  it. No flags = LIST (reading needs no
                                  write token): the owner, then every share
                                  — edit|read, the email, why it exists
                                  (shared by hand / calendar invite (import)
                                  / calendar invite (linked event) / auditor
                                  / series follower / previous owner) and
                                  when + by whom it was added. --add shares
                                  it with someone in the Trames people
                                  directory (the people the web Share dialog
                                  offers; any other address is refused,
                                  exit 1, with "did you mean") at edit
                                  (the dialog's default) or --access read;
                                  someone who already has a share keeps
                                  their level unless --access says
                                  otherwise. A NEW share Slack-DMs the
                                  person, exactly like a web share.
                                  --remove takes a share off (removing an
                                  auditor or series follower is recorded,
                                  as in the web UI; the owner and people it
                                  is not shared with are refused, exit 1).
                                  Owner or editors only (readers: refused,
                                  exit 1). Several ids = the same change on
                                  each, then each meeting's list; --json =
                                  {id,title,url,your_access,owner,
                                  shared_with[],changes[]} (an array for
                                  several ids). Ownership transfer stays in
                                  the web dialog ('Make owner…').
                                  share <id> --suggestions = the dialog's
                                  "Suggested from this meeting" (named
                                  speakers + Trames invitees not shared yet,
                                  with why); --add-suggested [--access read]
                                  adds each of them through --add (edit by
                                  default; same directory check + Slack DM).
                                  Readers get no suggestions
  set-title <id> <title>          Update the title
  set-notes <id> --file <md|->    Replace the notes markdown ('-' = stdin)
  set-report <id> --file <md|->   Replace the report markdown ('-' = stdin)
  set-description <id> --file <md|->
                                  Replace the description under the title
                                  ('-' = stdin; trimmed; an empty file clears it)
  keep <id>[,<id>…]               The web UI's Keep on a temporary (scratch)
                                  row: it becomes permanent (no 30-day trash).
                                  One line per id; carries on past a failure,
                                  exit 1 if any failed
  unlink <id>                     Detach the calendar event ("Unlink from
                                  event"): its keys + attendees come off, the
                                  shares the link created are removed (printed);
                                  recording, title, date and notes stay. 409
                                  when it is not linked
  fetch-recording <id>            Pull the meeting's recording from Google Drive
                                  (your Google link) or Microsoft 365 and store
                                  it — for a transcript-only import. 'already'
                                  when it is stored; 422 = no recording known.
                                  Can take minutes for a long call
  retry <id>                      "Retry now" on a failed hand-off to
                                  transcription (status error, bytes stored):
                                  202 = back to 'uploading'; 409 = not a failed
                                  hand-off
  attach <id> <file> [--title "…"]
                                  Attach context (agenda, deck, pdf/docx/pptx/
                                  xlsx/text; max 25 MB) — text is extracted at
                                  upload and the summary run reads it.
                                  --text <file|-> instead of a file attaches
                                  pasted text (title default "Pasted notes").
                                  Prints the attachment id
  attachment-rm <id> <attId>      Remove one attachment ('attachments <id>' ids)
  edit-line <id> <n> --text "…"   Correct utterance n (from 'text <id> --index'):
                                  the edit is a layer over the raw words, like
                                  the page's inline edit. Prints before/after
  replace <id> <find> <with> [--case] [--dry-run]
                                  The Find & Replace panel's "Replace all" over
                                  the edited text: case-insensitive unless
                                  --case; --dry-run lists the lines it would
                                  change (before/after) and writes nothing —
                                  run it first. '' as <with> deletes. Put the
                                  flags after the three arguments
  trash <id> [--cancel-queued]    Move a transcript you OWN to the trash (soft
                                  delete: gone from listings/search/series for
                                  everyone, transcript + audio + notes kept).
                                  Reversible with 'restore'; permanent
                                  deletion is web-only (Trash tab).
                                  --cancel-queued = the listing's "Cancel
                                  queued import": deletes a 'waiting'
                                  placeholder for good (an 'uploading' one
                                  stays refused)
  restore <id>                    Bring a trashed transcript back (owner only)
  label / unlabel / label-create / label-rename / label-mv / label-rm
                                  (label/unlabel also need owner or edit access
                                  on that transcript; readers get 403)
  skill                           Print the agent workflow guide

ACCOUNT-SETTINGS writes ('auto-sync off|mine|all', 'notify <kind> on|off',
'offline prefs --set', 'vocab --set') need a consent the human approved on
darth-auth:
  --consent '<dcon_id>: <approved text>'   (ONE argument, the sentence verbatim)
Without it the verb prints the request command and exits 6:
  darth-cli consent request --service meetings --action settings --target - \\
    --text 'Change my Darth Meetings settings (<area>) as <you> asked'
Ask for one ONLY when the human explicitly asked for that exact settings
change — never on your own initiative. The old
--i-have-got-consent-from-human-user flag is retired (exit 6).
'darth-cli consent skill' explains the whole flow.

FILTERS (list / search / export / calendar — all AND together; a comma
inside one value = OR; matching is case-insensitive substring)
  --participant <s>   organizer email, attendee emails + display names, and
                      (archive rows) speaker names. "@lp-global.com" = whole
                      domain, "nicolas" = a person. e.g. --participant a@x.com,b@y
  --organizer <s>     organizer email only
  --provider <p>      teams | gmeet | upload (comma = OR; 'upload' never matches
                      calendar rows). Anything else is rejected
  --speaker <s>       speaker names only (archive: list / search / export)
  --summary <s>       missing | failed (comma = OR; archive: list / search /
                      export). missing = completed, no summary, no run in
                      flight or failed; failed = the last run errored.
                      --no-summary is shorthand for --summary missing
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
/transcript/<id>). A pasted meetings link works anywhere an id does — both
https://meetings…/transcript/<id> and the permanent https://meetings…/m/<uuid>
(Slack DMs, calendar rows, 'import'; its uuid is NOT the transcript id, the
CLI looks it up). Pass the link as-is rather than cutting the uuid out.
Timestamps in 'text' output are utterance starts — feed
them to 'frame' to see what was on screen at that moment. 'calendar' rows
show [meeting-code] — feed it to 'import' to import the occurrence from
here (server-side, your backend Google link; Teams runs app-only).

If the server is unreachable, the user is probably off the company VPN/
tailnet — say so and wait; don't retry-loop.

Per-subcommand --help is not a thing — this page is the whole reference
(except 'darth-cli meetings recordings', which has its own page).
`;

const SKILL = `# darth meetings — agent workflow guide

This CLI deliberately has NO AI commands. You (the agent reading this) are
the intelligence; the CLI gives you deterministic primitives. You spend your
own tokens, then write results back so humans see them in the web UI.

## The core loop: summarize / analyze a meeting

    darth-cli meetings list --json          # find the transcript id
                                            # (or pass a pasted meetings link as <id>)
    darth-cli meetings text <id>            # full transcript, speaker-named
    # ...you read/analyze/summarize with YOUR model...
    darth-cli meetings set-notes <id> --file summary.md    # write it back

set-notes/set-report replace the markdown shown in the web UI's Summary /
Report tabs and are logged as "updated notes via darth-cli" in the activity
feed. Notes = quick summary tier; report = detailed wiki-style tier.

The CLI never starts the service's own AI runs: an upload gets whatever the
web UI's default generation produces (since 2026-09-21 that is always BOTH
tiers — the quick summary AND the detailed report), and starting a run is a
human's web-UI ask (Generate…). You READ whatever exists with 'notes <id>' /
'report <id>' and WRITE your own with 'set-notes' / 'set-report <id> --file
report.md' — that is the whole point.

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
'--calendar alice@trames.sg' (repeatable, max 5) also reads a calendar
shared with the human — the person's email is the id; it needs at least
free/busy sharing (free/busy rows show "(busy)" with no title or people),
and the rows are tagged cal:alice; the footer says which calendars answered.

## Someone hands you a recording ("here's the audio, do your thing")

People will drop an audio/video file on you without saying which meeting
it was. The system is built so this costs ONE transcription run: upload
first, decide what it belongs to afterwards. Linking later is a metadata
write (date, title, attendees, and a share with the invite's Trames
colleagues) — nothing is re-run.

    # 1. If you ALREADY know the event, link up front (best case: title,
    #    date, attendees land at once, and the meeting is shared with the
    #    invite's Trames colleagues — as a Meet/Teams import would be):
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
    #    the human agreed to, and leave the rest as guesses). A speaker is a
    #    PERSON: pass the email when you have it (the invite usually has it;
    #    the server fills the canonical name), a bare name only when you don't:
    darth-cli meetings set-speakers <id> A=wei@partner.example B="Alok Rajiv <alok@trames.sg>" C="Interviewer #1"
    darth-cli meetings set-speakers <id> --from-invite          # table of guesses that name one invitee
    darth-cli meetings set-speakers <id> --from-invite --yes    # …confirm them all
    # 6. Two ways to the summary. (a) The server's own run — exactly the web
    #    UI's "Generate summary & report", both tiers, with the dialog's options
    #    (plan first, --yes starts it; 'generate <id> --cancel' drops a
    #    scheduled one; 'hold <id>' stops the automatic one of a manual upload):
    darth-cli meetings generate <id> --yes [--instructions "focus on decisions"] [--no-video] [--run-at tonight]
    #    (b) Or the normal loop: read 'text <id>', write notes with your model,
    #    'set-notes <id> --file notes.md'; 'label' it; and if the human asked,
    #    'share <id> --add <email>' (see "Sharing a meeting" below).

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

## Recordings (private, never shared)

Once the server runs born-bare uploads, 'upload' WITHOUT --event makes a
private RECORDING, not a meeting: it prints 'uploaded to your Recordings —
<uuid>', it is not in 'list', and the meeting verbs (get/text/speakers/
set-*) do not take its id. Steps 2-4 above then read:

    darth-cli meetings upload ./call.m4a --wait     # → recording <uuid>
    darth-cli meetings recordings text <uuid>       # skim it
    darth-cli meetings recordings get <uuid>        # + a confident calendar suggestion, if any
    darth-cli meetings recordings link <uuid> 'evt123|2026-09-15T06:00:00.000Z'   # → a meeting
    darth-cli meetings recordings make-meeting <uuid> --title "Ad-hoc call"      # no event

Linking / make-meeting prints the new MEETING id — from there the normal
verbs apply (speakers, set-speakers, set-notes, …). A recording is never
shared; share the MEETING ('share <meeting-id> --add <email>'). 'recordings list'
shows everything still private (--temporary / --unlinked; --json
--envelope pages like the tasks list).

## Segments (one recording, several meetings — or several recordings, one meeting)

A meeting is a TIMELINE of segments; a segment is a window of one recording
placed at a time on it. Nothing is ever cut or re-transcribed: a segment is a
pointer, and the meeting's text, player and AI notes are built from its
segments. So NEVER reach for ffmpeg to split or join recordings — do it here.

One recording that covers two meetings (a 1:1 that became a wider call at
43:03):

    darth-cli meetings recordings make-meeting <rid> --title "Call, part 1"    # → meeting A (whole recording)
    darth-cli meetings segments propose A                                     # optional: server suggests split points
    darth-cli meetings split A --from 43:03 --to 1:54:29 --title "Call, part 2" [--event <ref>]
                                                                              # → meeting B holds 43:03→end; A keeps 0:00→43:03 with a hole
    darth-cli meetings segments A                                             # the timeline, holes, siblings
    darth-cli meetings unsplit B                                              # undo

Several recordings of one call (a phone in the room + the Teams file; two
colleagues' Macs):

    darth-cli meetings segments candidates <meeting>                          # what you could add (your own bytes only)
    darth-cli meetings segments align <rid> --against <rid-of-first-segment>  # measures the offset; applies nothing
    darth-cli meetings segments add <meeting> <rid> --at 1:12 [--from T --to T] [--text gap-fill]
    darth-cli meetings segments edit <meeting> 1 --at 1:15                    # nudge it
    darth-cli meetings segments rm <meeting> 1

Text policy per segment: include (words merge by time), gap-fill (its words
only where no other segment has speech), exclude (playable, no text). The
server never guesses where a segment sits: --at defaults to 0:00, measure it
with 'segments align' or set it by ear. Speaker names and text edits move
with a split and come back with unsplit.

Splitting right after a recording landed: the speaker-ID pass runs for about
a minute after transcription, and the server refuses to split while it does
(409 speaker_check_running) — a half born mid-pass would wait for names
forever. 'split' waits for you (retries every 10 s, up to 3 min); pass
--no-wait to fail at once instead. Naming EVERY speaker with set-speakers
also ends the pass, so a meeting you have fully named is splittable at once.

## Mixed-language recordings

AssemblyAI picks ONE language per file. On a call in two languages (English +
Indonesian, English + Mandarin, …) one pass is always wrong somewhere:

- detected/forced English → the other language comes out as invented text in
  a foreign script (Vietnamese, Thai, Hindi…) or low-confidence gibberish;
  FORCED en is worse — it DROPS the other language's speech (−28% of the
  audio covered in a probe), leaving holes nothing can fill;
- forced other language (or auto-detect landing on it) → that language is
  clean, but the English turns are TRANSLATED into it (or dropped).

Symptoms: garbled foreign-script lines in 'text', a report that says it
"relied on the English parts", or a HEALTH line saying MIXED LANGUAGE
SUSPECTED. The fix is a second pass plus a MERGE: the English version stays
the skeleton (speakers, turns, names, edits), and the other version's words
replace it only where the English pass had low confidence.

    darth-cli meetings transcriptions <id>        # versions + HEALTH + the exact next command
    # active version is English (en*):
    darth-cli meetings transcribe-again <id> --language id --merge --wait
    # active version is the OTHER language (auto-detect landed on id):
    darth-cli meetings transcribe-again <id> --language auto-en --merge --wait
    darth-cli meetings text <id>                  # spot-check the merged (now active) text
    darth-cli meetings use-transcription <id> <previous tid>   # back, if it is worse

<code> is the language YOU suspect from the garbage (id for Indonesian, zh for
Chinese, …) — the CLI cannot know it. auto-en is an English pass that keeps the
other language's speech present (garbled) so the merge has something to swap.
The server puts the English version as the base whichever side you start
from; --wait exits 0 when done, 1 on an error (or if no merge was made — it
then prints the merge-transcriptions command), 3 if still running at
--timeout. Already have both versions? Merge without a new pass:

    darth-cli meetings merge-transcriptions <id> --base <en tid> --fill <other tid> --dry-run
    darth-cli meetings merge-transcriptions <id> --base <en tid> --fill <other tid> --activate

--dry-run prints what would change (before/after per touched utterance) and
any WARNING (e.g. "base is not an English version"); --threshold (default
0.75) is the confidence below which the base's words are swapped. 'text <id>
--version <tid>' reads any version without switching to it.

RULES: on a mixed call NEVER run 'transcribe-again --language <code>' without
--merge or --keep-active — forced en drops the other language's speech and a
forced other language translates the English, and either would REPLACE the
active version. Each extra pass costs ~$0.17 per hour of audio (AssemblyAI) —
fine for a real meeting, but don't loop. After switching versions the notes /
report were written from the old text: a human regenerates them in the web UI
(or you write new ones with 'set-notes' / 'set-report'). A recording in no
meeting has the same verbs under 'recordings' (owner only).

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

## Sharing a meeting (who has access)

    darth-cli meetings share <id>                           # owner + every share, why, when, by whom
    darth-cli meetings share <id> --add ivan@trames.sg      # edit (the web dialog's default)
    darth-cli meetings share <id> --add bea@trames.sg --access read
    darth-cli meetings share <id> --remove bob@trames.sg
    darth-cli meetings share id1,id2,id3 --add ivan@trames.sg   # same change on several meetings

It is the web Share dialog's own server path: the owner or an editor may
change shares (a reader is refused), only people in the Trames directory
can be added (an unknown or misspelt address changes nothing, exit 1, and
names the closest matches), and a NEW share sends that person the same
Slack DM a web share does — so share only when your human asked for it,
with whom they named. "Only me and Ivan should see this": run 'share <id>',
then '--remove' everyone else — but tell the human first what the list
holds: calendar-invite shares are the colleagues on the invite, auditor
shares come from the outside-party rule (removing one is recorded and the
auditors can see it), series-follower shares are the series' followers. 'get
<id>' prints the same people on one line. Recordings are never shared; share
the meeting. Ownership transfer stays in the web dialog.

## Fixing the text, adding context, retrying

A misheard name or term is fixed in the transcript's EDIT layer (the raw
words are kept), exactly like the page's inline edit / Find & Replace:

    darth-cli meetings text <id> --index                 # "[12] [mm:ss] Speaker: …"
    darth-cli meetings edit-line <id> 12 --text "We ship on Monday."
    darth-cli meetings replace <id> "Tramies" "Trames" --dry-run   # always look first
    darth-cli meetings replace <id> "Tramies" "Trames"             # then write

Today the edit layer is what the web PAGE shows; 'text' / 'export' and the
server's summary run still read the raw words, so for your own summary apply
the fix in your reading as well.

An agenda, deck or pasted brief the summary should know about goes in as an
attachment ('attach <id> agenda.pdf --title "Agenda"', or 'attach <id> --text
brief.md'); 'attachments <id>' lists them. An upload whose hand-off to
transcription failed (status error) is re-run with 'retry <id>'.

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
- ACCOUNT SETTINGS ('auto-sync off|mine|all', 'notify <kind> on|off',
  'offline prefs --set') change how the service behaves for your human long
  after this session. Never touch them on your own initiative. When the human
  explicitly asks for one, the verb (without a consent) exits 6 and prints
    darth-cli consent request --service meetings --action settings --target - --text '…'
  Run that, tell the human what you asked for and where to approve it, then
  'darth-cli consent check <id> --wait 600', and re-run the verb with the
  EXACT --consent '<id>: <approved text>' the request printed (the human may
  have edited the sentence — use theirs; a revoked/denied consent means stop).
  Never paraphrase it, never put it in an env var or a file. The old
  --i-have-got-consent-from-human-user flag is retired (exit 6).
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
// Meeting links → transcript ids
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `https://meetings…/m/<uuid>`, `…/transcript/<id>`, scheme or host optional. */
const MEETING_URL_RE = /^(?:https?:\/\/)?([^\/\s?#]*)\/(m|transcript)\/([^\/?#\s]+)\/?(?:[?#]\S*)?$/i;

/** Verbs whose first argument is a meeting (transcript) id. */
const MEETING_ID_VERBS = new Set([
  "get", "text", "notes", "report", "audio", "frame", "attachments", "attachment-get", "link", "set-date",
  "speakers", "set-speakers", "set-title", "set-notes", "set-report", "trash", "restore", "label", "unlabel", "share",
  "set-description", "keep", "unlink", "fetch-recording", "retry", "activity", "ai-runs", "attach", "attachment-rm",
  "edit-line", "replace",
]);

/** The transcript id behind a /m/<uuid> permalink. `status` 404 = the caller
 * cannot open it (unknown, not shared, or not imported yet — one answer);
 * 0 = the server was not reachable. */
async function transcriptIdForMeetingUuid(ctx: Ctx, uuid: string): Promise<{ tid: string | null; status: number }> {
  try {
    const res = await ctx.api("meetings", `/api/meetings/resolve?m=${encodeURIComponent(uuid)}`);
    const j: any = await res.json().catch(() => null);
    return { tid: res.ok && typeof j?.transcriptId === "string" ? j.transcriptId : null, status: res.status };
  } catch {
    return { tid: null, status: 0 };
  }
}

/**
 * Every verb takes the TRANSCRIPT id, but the web app hands out two link
 * forms: /transcript/<id> and the permanent /m/<uuid> (Slack DMs, calendar
 * rows, import), whose uuid is the meetings row — a different id. A browser
 * gets the redirect; here: a pasted link of either form (alone or inside a
 * comma list) becomes the transcript id, and a bare uuid given as a meeting
 * verb's id that turns out to be an /m/ uuid is swapped for its transcript id
 * with a note on stderr. An /m/ link the caller cannot open stops the run
 * with the reason instead of a bare "Not found" further down.
 */
async function resolveMeetingRefs(ctx: Ctx, pos: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const arg of pos) {
    const parts = arg.split(",");
    if (!parts.some(p => MEETING_URL_RE.test(p.trim()))) { out.push(arg); continue; }
    const mapped: string[] = [];
    for (const raw of parts) {
      const p = raw.trim();
      const m = MEETING_URL_RE.exec(p);
      const host = m?.[1] ?? "";
      if (!m || (host && host !== new URL(webBase(ctx)).host && !/meetings/i.test(host))) { mapped.push(p); continue; }
      const id = decodeURIComponent(m[3]);
      if (m[2].toLowerCase() === "transcript") { mapped.push(id); continue; }
      const r = UUID_RE.test(id) ? await transcriptIdForMeetingUuid(ctx, id) : { tid: null, status: 404 };
      if (!r.tid) {
        if (r.status === 404) console.error(`${p}: no meeting you can open behind this link (unknown, not shared with you, or not imported yet). Ask the owner to share it, or check the link.`);
        else if (r.status === 401) console.error(`${p}: Unauthorized — your token may be expired/revoked — run: darth-cli login`);
        else console.error(`${p}: could not resolve the link (${r.status ? `HTTP ${r.status}` : "server unreachable — off the VPN/tailnet?"}).`);
        process.exit(r.status === 401 ? 3 : 1);
      }
      mapped.push(r.tid);
    }
    out.push(mapped.join(","));
  }
  const [, cmd, ...args] = out.length && out[0] === "meetings" ? out : ["", ...out];
  const first = args[0];
  if (first && UUID_RE.test(first) && (MEETING_ID_VERBS.has(cmd) || (VERSION_VERBS as readonly string[]).includes(cmd))) {
    const { tid } = await transcriptIdForMeetingUuid(ctx, first);
    if (tid && tid !== first) {
      console.error(`note: ${first} is a meeting link id (/m/${first}) — using its transcript id ${tid}`);
      out[out.length - args.length] = tid;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared filter flags (list / search / export / calendar)
// ---------------------------------------------------------------------------

/** Server-side filter params — names are the API contract of
 * GET /api/transcripts?v=2, /api/transcripts/search, /api/calendar-meetings. */
const PEOPLE_FLAGS = ["participant", "organizer", "provider", "speaker", "summary"] as const;
const RANGE_FLAGS = ["from", "to"] as const;
const ALL_FILTER_FLAGS = [...PEOPLE_FLAGS, ...RANGE_FLAGS, "q"] as const;
const PROVIDERS = ["teams", "gmeet", "upload"];
/** `--summary` values (server: lib/server/meeting-filters.ts). `--no-summary` = `--summary missing`. */
const SUMMARY_STATES = ["missing", "failed"];
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
/** The pre-consents bare flag. Retired (consents CONTRACT §5): kept only so
 * the boolean lift still frees a swallowed positional and the verb can say
 * the flag is gone instead of failing on something else. */
const RETIRED_CONSENT_FLAG = "i-have-got-consent-from-human-user";
/** Family-wide exit code for "a human-approved consent is needed" (CONTRACT §0). */
const CONSENT_EXIT = 6;

type SettingsArea = "auto-sync" | "notifications" | "offline prefs" | "vocabulary" | "company vocabulary";

/** `ctx.consent` — set by darth-cli core (≥0.77.0) from `--consent '<id>: <text>'`;
 * read defensively so this file still builds against an older core. */
function consentOf(ctx: Ctx): { id: string; text: string } | null {
  return (ctx as Ctx & { consent?: { id: string; text: string } | null }).consent ?? null;
}

/** Same sentence the server suggests (src/lib/auth/consent.ts settingsSuggestedText):
 * first word of the caller's mailbox, capitalised. */
function settingsConsentText(ctx: Ctx, area: SettingsArea): string {
  const first = ((ctx.config.email || "").split("@")[0] || "").split(/[._+-]/)[0] || "";
  const who = first ? first[0].toUpperCase() + first.slice(1) : "the user";
  return `Change my Darth Meetings settings (${area}) as ${who} asked`;
}

function settingsConsentRequest(ctx: Ctx, area: SettingsArea): string {
  const text = settingsConsentText(ctx, area).replace(/'/g, `'\\''`);
  return `darth-cli consent request --service meetings --action settings --target - --text '${text}'`;
}

/** Account-settings writes (auto-sync, notify, offline prefs) change how the
 * service behaves for the human LONG after this session — they need a consent
 * the human approved on darth-auth (`meetings:settings`). With `--consent`
 * (ctx.consent) the request goes out and the server verifies it; without one
 * (or with the retired bare flag) print the request command and exit 6. */
function requireConsent(ctx: Ctx, flags: Record<string, string | boolean>, area: SettingsArea): boolean {
  const request = settingsConsentRequest(ctx, area);
  if (flags[RETIRED_CONSENT_FLAG] !== undefined) {
    console.error(
      `--${RETIRED_CONSENT_FLAG}: this flag is retired — this verb now needs ` +
        `--consent '<dcon_id>: <text>' (run: ${request})\n` +
        `then re-run this command with --consent '<id>: <approved text>' exactly as the request printed it.`
    );
    return false;
  }
  if (consentOf(ctx)) return true;
  console.error(
    `Changing ${area} is an account-settings write: this verb needs --consent '<dcon_id>: <text>' ` +
      `(run: ${request})\n` +
      `then re-run this command with --consent '<id>: <approved text>' exactly as the request printed it. ` +
      `Ask for it ONLY when the human explicitly asked for this exact change.`
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
  // --no-summary is sugar for --summary missing (the common ask: "which
  // meetings still have no summary?"). A boolean flag: a swallowed next token
  // is an error, never a silently dropped positional.
  if (flags["no-summary"] !== undefined) {
    if (!allow.includes("summary")) return { ok: false, error: "--no-summary is not supported by this command" };
    if (typeof flags["no-summary"] === "string") return { ok: false, error: `--no-summary takes no value (got '${flags["no-summary"]}') — put it last, or use --summary missing` };
    if (flags.summary !== undefined && String(flags.summary).trim().toLowerCase() !== "missing") return { ok: false, error: "--no-summary means --summary missing; drop one of the two" };
    flags = { ...flags, summary: "missing" };
  }
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
    if (name === "summary") {
      const bad = val.split(",").map(x => x.trim().toLowerCase()).filter(x => x && !SUMMARY_STATES.includes(x));
      if (bad.length) return { ok: false, error: `--summary: unknown value(s) ${bad.join(", ")} — use ${SUMMARY_STATES.join("|")} (comma = OR), or --no-summary` };
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
  // Another person's calendar: no import / evidence lookups are made for it.
  if (e.calendar) return e.upcoming ? "upcoming" : "past(shared-cal)";
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
  /** --separate: never join the occurrence's existing meeting. */
  separate?: boolean;
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
    linkMode: opts.separate ? "separate" : undefined,
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
  if (done.transcriptId?.startsWith("rec-")) {
    // Born-bare upload: the session poll only carries 'rec-<uuid>' — a
    // recording, not a meetings row (never GET /api/transcripts/rec-…).
    const rid = done.transcriptId.slice(4);
    const g = await ctx.expectJson<{ recording: any }>(ctx.api("meetings", `/api/recordings/${rid}`));
    const v = g.recording ?? {};
    return {
      transcript: {
        assemblyai_id: done.transcriptId, recording_id: rid, born_bare: true, status: v.status, title: v.title ?? null,
        original_filename: v.original_filename ?? null, created_at: v.created_at ?? null, expires_at: v.expires_at ?? null, scratch: v.temporary === true,
      },
    };
  }
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

// A speaker is a PERSON (lib/speaker-identity, 2026-10-27): labels and
// guesses may carry the person's email; the server stores the canonical name
// for an email and attaches emails to guesses that name exactly one invitee.
const EMAIL_SHAPE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
interface SpeakerAssignment { originalSpeaker: string; customName: string; email?: string }

/** `A=Name` · `A=email@x` (name resolved server-side) · `A="Name <email@x>"`. Null = not an assignment. */
function parseSpeakerAssignment(p: string): SpeakerAssignment | null {
  const eq = p.indexOf("=");
  if (eq <= 0) return null;
  const originalSpeaker = p.slice(0, eq).trim();
  const value = p.slice(eq + 1).trim();
  if (!originalSpeaker) return null;
  // "Name <…>": whatever is in the brackets must be an address, else the
  // whole assignment is refused (never stored as a name with brackets in it).
  const angled = /^(.*?)\s*<([^<>]*)>$/.exec(value);
  if (angled) {
    const email = angled[2]!.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) return null;
    return { originalSpeaker, customName: angled[1]!.trim(), email };
  }
  if (EMAIL_SHAPE.test(value)) return { originalSpeaker, customName: "", email: value.toLowerCase() };
  return { originalSpeaker, customName: value };
}

/** "Name <email>" when the email is known, else the name. */
function fmtPerson(name: string | null | undefined, email?: string | null): string {
  const n = (name ?? "").trim();
  return email ? (n ? `${n} <${email}>` : `<${email}>`) : n;
}

/** --from-invite: unconfirmed speakers whose guess names one person (has an email). */
type SpeakersReply = {
  speakerLabels?: Array<{ originalSpeaker: string; customName?: string; description?: string; email?: string }>;
  suggestions?: Record<string, { name?: unknown; email?: unknown } | undefined>;
};
function fromInvitePicks(cur: SpeakersReply): SpeakerAssignment[] {
  const labels = new Map((cur.speakerLabels || []).map((l) => [l.originalSpeaker, l]));
  const out: SpeakerAssignment[] = [];
  for (const [sp, g] of Object.entries(cur.suggestions || {})) {
    if (!g?.email || !String(g?.name ?? "").trim()) continue;
    if (labels.get(sp)?.customName?.trim()) continue;
    out.push({ originalSpeaker: sp, customName: String(g.name).trim(), email: String(g.email).toLowerCase() });
  }
  return out.sort((a, b) => a.originalSpeaker.localeCompare(b.originalSpeaker));
}

// ---------------------------------------------------------------------------
// generate / hold / add-person — the web UI's write actions over the same
// routes (task 05 CLI↔UI parity: an agent must not have to tell the human
// "click Generate"). One run writes both tiers, like the dialog.
// ---------------------------------------------------------------------------

/** Non-2xx on one of the parity writes → a readable line; returns the exit code. */
function writeError(verb: string, status: number, data: { error?: unknown } | null, id?: string): number {
  const msg = typeof data?.error === "string" ? data.error : `HTTP ${status}`;
  if (status === 401) console.error(`Unauthorized: ${msg}\nYour token may be expired/revoked — run: darth-cli login`);
  else if (status === 403) console.error(`Forbidden: ${msg}\nYou need EDIT access${id ? ` to ${id}` : ""} and a read+write token (re-run 'darth-cli login' and pick Read + write).`);
  else if (status === 404) console.error(`${verb} failed: not found (${msg})${id ? ` — no meeting ${id} visible to you` : ""}.`);
  else if (status === 409) console.error(`${verb} refused: ${msg}`);
  else console.error(`${verb} failed (HTTP ${status}): ${msg}`);
  return status === 401 ? 3 : 1;
}

/** 'tonight' = the next 02:00 local (what the dialog offers), else an ISO instant. Null = unreadable. */
function runAtFlag(raw: string | undefined, now = new Date()): string | null | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "now") return undefined;
  if (v === "tonight") {
    const t = new Date(now);
    t.setHours(2, 0, 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return t.toISOString();
  }
  const t = new Date(raw.trim());
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** darth-cli meetings generate <id> [--instructions …] [--no-video] [--run-at …] [--yes] | --cancel */
async function generateCmd(ctx: Ctx, flags: Record<string, string | boolean>, args: string[]): Promise<number> {
  const id = args[0];
  const usage = "usage: darth-cli meetings generate <id> [--instructions \"…\"] [--no-video] [--run-at <iso|tonight>] --yes   |   generate <id> --cancel";
  if (!id) { console.error(usage); return 1; }
  ctx.requireWrite();

  if (flags.cancel === true) {
    const res = await ctx.api("meetings", `/api/transcripts/${id}/report`, { method: "DELETE" });
    const data = await readJsonSafe(res);
    if (!res.ok) return writeError("generate --cancel", res.status, data, id);
    ctx.print(data, () => console.log(`cancelled the scheduled/queued run on ${id} — a run already in flight is not touched.`));
    return 0;
  }

  const instructions = str(flags.instructions)?.trim() || undefined;
  if (instructions && instructions.length > 2000) { console.error("--instructions is capped at 2000 characters (the server truncates there)"); return 1; }
  const runAt = runAtFlag(str(flags["run-at"]));
  if (runAt === null) { console.error(`--run-at: '${String(flags["run-at"])}' is not 'tonight' or an ISO instant`); return 1; }
  const useVideo = flags["no-video"] !== true;
  const body: Record<string, unknown> = { useVideo };
  if (instructions) body.instructions = instructions;
  if (runAt) body.runAt = runAt;

  // The dialog is the UI's confirm step; here the plan is printed unless --yes.
  const rowRes = await ctx.api("meetings", `/api/transcripts/${id}`);
  const rowData = await readJsonSafe(rowRes);
  if (!rowRes.ok) return writeError("generate", rowRes.status, rowData, id);
  const t = (rowData?.transcript ?? {}) as Record<string, unknown>;
  const has = !!(t.auto_notes || t.auto_report);
  const plan = [
    `${has ? "REGENERATE" : "generate"} summary + detailed report for ${id} ${t.title ? `"${t.title}"` : ""}`.trim(),
    `  report: ${useVideo ? "with screenshots when the recording has video" : "text only (--no-video)"}`,
    `  instructions: ${instructions ? JSON.stringify(instructions) : "(none)"}`,
    `  when: ${runAt ? `scheduled for ${fmtLocalDateTime(runAt, localTz(ctx))} (${runAt})` : "now"}`,
    ...(has ? ["  the existing notes/report are replaced when the run lands"] : []),
  ];
  if (flags.yes !== true) {
    for (const l of plan) console.log(l);
    console.log("dry run — nothing started. Re-run with --yes to start it.");
    return 0;
  }
  if (t.status !== "completed") { console.error(`${id} is not completed yet (status ${String(t.status)}) — nothing to summarise`); return 1; }

  const res = await ctx.api("meetings", `/api/transcripts/${id}/report`, { method: "POST", body: JSON.stringify(body) });
  const data = await readJsonSafe(res);
  if (!res.ok) return writeError("generate", res.status, data, id);
  ctx.print({ ...data, id, regenerate: has, useVideo, ...(instructions ? { instructions } : {}), ...(runAt ? { runAt } : {}) }, () => {
    const s = String(data?.status ?? "running");
    if (s === "scheduled") console.log(`scheduled: summary + detailed report for ${id} run at ${fmtLocalDateTime(String(data.runAt ?? runAt), localTz(ctx))} — 'generate ${id} --cancel' drops it.`);
    else if (s === "queued") console.log(`queued: ${id} waits for its recording to land, then the run starts (video report).`);
    else console.log(`${has ? "regenerating" : "generating"} summary + detailed report for ${id} — 'get ${id}' shows auto_notes_status / auto_report_status; 'notes ${id}' / 'report ${id}' once completed.`);
  });
  return 0;
}

/** The HELP lines of one verb: from its line to the next verb's. Null when unknown. */
function helpForVerb(verb: string): string | null {
  for (const text of [HELP, SEGMENTS_HELP, RECORDINGS_HELP]) {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => new RegExp(`^  ${verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(l));
    if (start < 0) continue;
    const out = [lines[start]!];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (!l.trim() || /^\S/.test(l) || /^  \S/.test(l)) break;
      out.push(l);
    }
    return out.join("\n");
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI ↔ UI parity, batch A (task 05) — the transcript page's remaining
// actions: description, Keep, unlink / "Not this", fetch the recording, retry
// a failed hand-off, activity + AI runs, attach / remove context, share
// suggestions, the voiceprint guess, and utterance edits (edit-line, the Find
// & Replace panel's "Replace all").
// ---------------------------------------------------------------------------

type JsonRec = Record<string, unknown>;
type EditEntry = { text?: string; speaker?: string };
type EditMap = Record<string, EditEntry>;

/** One meetings request → {ok, status, data}; a JSON body is sent with its content-type. */
async function meetingsCall(ctx: Ctx, path: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: JsonRec | null }> {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  const res = await ctx.api("meetings", path, init);
  return { ok: res.ok, status: res.status, data: (await readJsonSafe(res)) as JsonRec | null };
}

const asStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A file's text, or stdin for '-'. Null (with the reason on stderr) when unreadable. */
function readTextSource(flag: string, v: string | undefined): string | null {
  if (!v) { console.error(`--${flag} needs a file ('-' reads stdin)`); return null; }
  try { return v === "-" ? readFileSync(0, "utf8") : readFileSync(v, "utf8"); }
  catch (e) { console.error(`--${flag}: ${e instanceof Error ? e.message : String(e)}`); return null; }
}

/** Activity `details` → "k=v, k=v" on one line. */
function fmtDetails(d: unknown): string {
  if (!d || typeof d !== "object") return "";
  const parts = Object.entries(d as JsonRec)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`));
  return oneLine(parts.join(", "), 160);
}

/** "$0.1234" from the numeric-as-string cost column; "" when absent. */
function fmtCost(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : "";
}

/** The page's effective text of utterance i: the edit layer over the raw words. */
const effectiveText = (raw: string, edits: EditMap, i: number): string => edits[String(i)]?.text ?? raw;

/** One match of the Find & Replace panel: utterance + [start,end) in its effective text. */
type FindMatch = { utteranceIndex: number; start: number; end: number };

/**
 * The transcript page's `findMatches` (app/transcript/[id]/page.tsx), verbatim:
 * non-overlapping indexOf over the EFFECTIVE text of every utterance,
 * case-insensitive unless `caseSensitive`.
 */
function findMatchesIn(rawTexts: string[], edits: EditMap, query: string, caseSensitive: boolean): FindMatch[] {
  const out: FindMatch[] = [];
  const needleLen = query.length;
  if (!needleLen) return out;
  const cmpQuery = caseSensitive ? query : query.toLowerCase();
  for (let i = 0; i < rawTexts.length; i++) {
    const text = effectiveText(rawTexts[i]!, edits, i);
    const haystack = caseSensitive ? text : text.toLowerCase();
    let from = 0;
    while (from <= haystack.length - needleLen) {
      const idx = haystack.indexOf(cmpQuery, from);
      if (idx === -1) break;
      out.push({ utteranceIndex: i, start: idx, end: idx + needleLen });
      from = idx + needleLen;
    }
  }
  return out;
}

/**
 * The page's `handleReplaceAll`: splice right-to-left per utterance; a line
 * that ends up equal to the raw words drops its text override (keeping a
 * speaker override). Returns the next edit map and the changed lines.
 */
function replaceAllEdits(rawTexts: string[], edits: EditMap, matches: FindMatch[], replaceWith: string): { next: EditMap; changed: Array<{ i: number; before: string; after: string; n: number }> } {
  const next: EditMap = { ...edits };
  const grouped = new Map<number, FindMatch[]>();
  for (const m of matches) grouped.set(m.utteranceIndex, [...(grouped.get(m.utteranceIndex) ?? []), m]);
  const changed: Array<{ i: number; before: string; after: string; n: number }> = [];
  for (const [i, ms] of grouped) {
    const raw = rawTexts[i]!;
    const before = effectiveText(raw, edits, i);
    let text = before;
    for (const m of [...ms].sort((a, b) => b.start - a.start)) text = text.substring(0, m.start) + replaceWith + text.substring(m.end);
    const key = String(i);
    if (text === raw) {
      if (next[key]) {
        const rest: EditEntry = { ...next[key] };
        delete rest.text;
        if (rest.speaker !== undefined) next[key] = rest;
        else delete next[key];
      }
    } else {
      next[key] = { ...(next[key] ?? {}), text };
    }
    changed.push({ i, before, after: text, n: ms.length });
  }
  return { next, changed };
}

/** Raw utterances (text + rendered "[mm:ss] Speaker") and the edit layer of one meeting. */
async function fetchLinesAndEdits(ctx: Ctx, id: string): Promise<{ ok: true; lines: TranscriptText["lines"]; edits: EditMap } | { ok: false; code: number }> {
  const [rendered, ed] = await Promise.all([
    fetchTranscriptText(ctx, id, (p) => getJsonOrThrow(ctx, p)).catch((e: unknown) => e instanceof Error ? e : new Error(String(e))),
    meetingsCall(ctx, `/api/transcripts/${id}/edits`, "GET"),
  ]);
  if (!ed.ok) return { ok: false, code: writeError("read edits", ed.status, ed.data, id) };
  if (rendered instanceof Error) {
    const m = /^HTTP (\d+): (.*)$/s.exec(rendered.message);
    return { ok: false, code: writeError("read text", m ? Number(m[1]) : 0, { error: m ? m[2] : rendered.message }, id) };
  }
  return { ok: true, lines: rendered.lines, edits: ((ed.data?.edits ?? {}) as EditMap) };
}

/** The share dialog's "Suggested from this meeting". */
type ShareSuggestion = { name: string; email: string; reason: string | null };

async function shareSuggestionsCmd(ctx: Ctx, flags: Record<string, string | boolean>, argv: string[], args: string[]): Promise<number> {
  const ids = [...new Set(args.flatMap(a => a.split(",")).map(s => s.trim()).filter(Boolean))];
  const adding = flags["add-suggested"] === true;
  if (ids.length !== 1) { console.error("usage: darth-cli meetings share <id> --suggestions | --add-suggested [--access edit|read]   (one meeting)"); return 1; }
  const id = ids[0]!;
  if (adding) ctx.requireWrite();
  const r = await meetingsCall(ctx, `/api/transcripts/${id}/share-suggestions`, "GET");
  if (!r.ok) return shareRequestError(id, r.status, r.data);
  const list: ShareSuggestion[] = (Array.isArray(r.data?.suggestions) ? (r.data.suggestions as JsonRec[]) : [])
    .filter((s) => typeof s.email === "string")
    .map((s) => ({ name: asStr(s.name) ?? String(s.email), email: String(s.email).toLowerCase(), reason: asStr(s.reason) }));
  if (!list.length) {
    // The route answers a reader with [] (not 403): say which case this is.
    const row = await meetingsCall(ctx, `/api/transcripts/${id}`, "GET");
    const access = asStr((row.data?.transcript as JsonRec | undefined)?.access);
    const reader = access === "read";
    ctx.print({ id, suggestions: [], your_access: access }, () =>
      console.log(reader
        ? `no share suggestions for ${id} — you have read access; only the owner or an editor gets suggestions (and can share).`
        : `no share suggestions for ${id} — everyone the meeting points at (named speakers, Trames invitees) already has access.`));
    return reader && adding ? 1 : 0;
  }
  if (!adding) {
    ctx.print({ id, suggestions: list }, () => {
      console.log(`share suggestions for ${id} (from the meeting — not shared yet):`);
      for (const s of list) console.log(`  ${fmtPerson(s.name, s.email)}${s.reason ? `  — ${s.reason}` : ""}`);
      console.log(`share them all: darth-cli meetings share ${id} --add-suggested [--access read]   (one: share ${id} --add <email>)`);
    });
    return 0;
  }
  // Each suggestion through the ordinary 'share --add' path (directory check,
  // default edit, Slack DM on a new share) — exactly as if typed.
  const synthetic = [...argv, ...list.flatMap((s) => ["--add", s.email])];
  return shareCmd(ctx, flags, synthetic, [id]);
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
    // "(90%, voice, id-pass, on the invite)": confidence, how the guess was
    // made, and — when it names ONE person — where the identity came from.
    const where = g?.emailSource === "invite" ? ", on the invite" : g?.emailSource === "directory" ? ", in the directory" : g?.email ? "" : g ? ", no email match" : "";
    const guess = g ? `${fmtPerson(g.name, g.email)} (${Math.round((g.confidence ?? 0) * 100)}%${g.source ? `, ${g.source}` : ""}${g.via === "id" ? ", id-pass" : ""}${where})` : null;
    let line = `  ${orig.padEnd(10)} `;
    if (confirmed) line += `= ${fmtPerson(confirmed, l?.email)}   [confirmed${guess ? `; guess was ${guess}` : ""}]`;
    else if (guess) line += `? ${guess}${g.evidence ? `  — ${oneLine(String(g.evidence), 140)}` : ""}`;
    else line += "? (no guess)";
    console.log(line);
  }
  if (![...labels.values()].some((l: any) => l?.customName?.trim()))
    console.log("  confirm with: darth-cli meetings set-speakers <id> A=\"Full Name\" B=bea@trames.sg   (or A=\"Name <email>\")");
  if (fromInvitePicks(sp).length)
    console.log(`  guesses that name one invitee can be confirmed in one go: darth-cli meetings set-speakers ${id} --from-invite   (table first; --yes writes)`);
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

/** Every value of a repeatable `--name v` / `--name=v` flag, in order (the
 * shared parseArgs keeps only the last), comma lists split. */
function allFlagValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    let v: string | undefined;
    if (a === `--${name}`) { const n = argv[i + 1]; if (n !== undefined && !n.startsWith("--")) { v = n; i++; } }
    else if (a.startsWith(`--${name}=`)) v = a.slice(name.length + 3);
    if (v !== undefined) out.push(...v.split(",").map(x => x.trim()).filter(Boolean));
  }
  return out;
}

/** Like allFlagValues but WITHOUT the comma split — a title regex such as
 * `^Weekly MCAP, SL` is one value. */
function allFlagValuesRaw(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === `--${name}`) { const n = argv[i + 1]; if (n !== undefined && !n.startsWith("--")) { out.push(n); i++; } }
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  }
  return out;
}

/**
 * Series patterns from the command line: every `--pattern <regex>` is a title
 * pattern; `--invite-all a@x,b@y` (+ `--invite-any`, `--internal-only`,
 * `--recurring-only`, `--max-people N`) adds ONE invite pattern. Returns null
 * when no pattern flag was given at all (= leave the patterns alone).
 */
function patternsFromFlags(argv: string[], flags: Record<string, string | boolean>): any[] | null {
  const titles = allFlagValuesRaw(argv, "pattern").map((regex) => ({ kind: "title", regex }));
  const all = allFlagValues(argv, "invite-all");
  const pats: any[] = [...titles];
  if (all.length) {
    const inv: any = { kind: "invite", all };
    const any = allFlagValues(argv, "invite-any");
    if (any.length) inv.any = any;
    if (flags["internal-only"] === true) inv.internalOnly = true;
    if (flags["recurring-only"] === true) inv.recurringOnly = true;
    const max = str(flags["max-people"]);
    if (max !== undefined) inv.maxPeople = Number(max);
    pats.push(inv);
  }
  if (!pats.length && flags["clear-patterns"] !== true) return null;
  return pats;
}

const MAX_SHARED_CALENDARS = 5;

async function calendarAll(ctx: Ctx, flags: Record<string, string | boolean>, calendars: string[] = []): Promise<number> {
  const fr = readFilterFlags(ctx, flags, ["participant", "organizer", "provider", "q", "from", "to"]);
  if (!fr.ok) { console.error(fr.error); return 1; }
  if (flags.calendar === true) { console.error("--calendar needs a value (the person's email, e.g. --calendar alice@trames.sg)"); return 1; }
  const cals = [...new Set(calendars)];
  if (cals.length > MAX_SHARED_CALENDARS) { console.error(`--calendar: at most ${MAX_SHARED_CALENDARS} calendars per call (got ${cals.length})`); return 1; }
  const q = new URLSearchParams(fr.params);
  const tz = localTz(ctx);
  q.set("tz", tz);
  if (flags.cached === true) q.set("sync", "0");
  for (const c of cals) q.append("calendar", c);
  const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/calendar/events?${q.toString()}`));
  const details = flags.details === true;
  ctx.print(data, () => {
    const { range, events, counts, sync } = data;
    if (!data.connected) {
      console.error("Google is not connected for this account — connect it in the web app Settings (meetings.darth-internal.trames.io/settings) so the service can read your calendar. Showing the (empty) cache.");
    } else if (sync?.error) {
      console.error(`note: ${sync.error}`);
    }
    for (const err of sync?.errors ?? []) console.error(`note: ${err}`);
    const calLine = (data.calendars ?? []).length
      ? `calendars: ${data.calendars.map((c: any) => c.ok
          ? `${c.id} ok (${c.fetched}${c.access ? `, ${c.access === "freeBusy" ? "free/busy only" : "full details"}` : ""})`
          : `${c.id} FAILED (${String(c.error || "").replace(`${c.id}: `, "")})`).join(" · ")}`
      : "";
    if (!events.length) {
      console.log(`No calendar events between ${range.from} and ${range.to} (tz ${tz}).`);
      if (calLine) console.log(calLine);
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
      const who = e.organizerSelf && !e.calendar ? "me" : (e.organizerEmail || (e.calendarAccess === "freeBusy" ? "-" : "?"));
      const cols = [
        `  ${time}`,
        fmtMins(e.durationSecs).padStart(5),
        (e.provider || "-").padEnd(5),
        calendarAllStatus(e).padEnd(22),
        `${e.attendeeCount ?? 0} att`.padStart(7),
        who.padEnd(28),
        e.title || (e.calendarAccess === "freeBusy" ? "(busy)" : "(untitled)"),
      ];
      const imp = e.imported;
      const ai = imp?.accessible
        ? [imp.notes === "ready" ? "notes" : imp.notes === "running" ? "notes…" : null,
           imp.report === "ready" ? "report" : imp.report === "running" ? "report…" : null].filter(Boolean).join("+")
        : "";
      const tail = [
        e.calendar ? `cal:${String(e.calendar).split("@")[0]}` : null,
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
    if (calLine) console.log(calLine);
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

// ---------------------------------------------------------------------------
// Recordings — the caller's OWN recordings that belong to no meeting
// (docs/recordings-meetings-series-design.md). A sub-verb family under
// `meetings` (not a top-level darth-cli family: that would need the shared
// cli registry). Owner-only on the server — anything not yours is a 404.
// Recordings are never shared; link one to a calendar event or make a
// meeting of it, then share the MEETING.
// ---------------------------------------------------------------------------

const RECORDINGS_HELP = `darth-cli meetings recordings — your private recordings (not meetings yet)

A recording is an upload (or a Darth Recorder file) that belongs to no
meeting. It is PRIVATE to you and is never shared: link it to a calendar
event (the MEETING it makes is shared with the invite's Trames colleagues,
as a Meet/Teams import is) or make a meeting of it and share that MEETING
('darth-cli meetings share <meeting-id> --add <email>'). Once the server runs born-bare uploads, 'meetings upload' without
--event lands here instead of in 'meetings list'.

  recordings list [--section mac|uploaded|temporary|linked | --unlinked | --temporary]
                  [--q <text>] [--regex] [--limit N] [--cursor C] [--all]
                  [--json] [--envelope]
                                  Newest first. --unlinked = on your Macs +
                                  uploaded; --temporary = temporary only;
                                  --section linked = your recordings that a
                                  meeting holds (each with its meeting id —
                                  never part of the default list).
                                  One page (default 50, max 200) unless --all
                                  (follows next_cursor to the end). --json =
                                  the items array; --envelope (implies JSON)
                                  = {items,next_cursor,counts,truncated}.
                                  Legacy bare uploads show their meeting id
                                  ("legacy meeting row" — the other meetings
                                  verbs take it); Mac rows can only be
                                  uploaded from the tray
  recordings get <rid>            One recording: status, size, expiry (when
                                  temporary), the meetings using it, and a
                                  confident calendar suggestion if any
  recordings text <rid>           Its transcript as "[mm:ss] Speaker X: …"
                                  (diarization labels — names are set once
                                  it is a meeting)
  recordings audio <rid> [--out <file>]
                                  Download the media (default ./rec-<rid>.<ext>)
WRITE (needs read+write for meetings)
  recordings link <rid> <meeting-code|event-key|meeting-id> [--title T] [--offset-ms N] [--separate]
                                  Meeting code / '<eventId>|<startIso>' key /
                                  teams-… ref → makes the meeting for that
                                  calendar occurrence; anything else = the id
                                  of a meeting you own or edit → adds the
                                  recording to it (--offset-ms places it).
                                  A calendar link shares the MEETING with
                                  the invite's Trames colleagues; the
                                  recording itself stays private. When you
                                  can already open a meeting of that
                                  occurrence (a colleague linked theirs),
                                  the recording JOINS it as another
                                  recording — one meeting for the call;
                                  --separate makes a meeting of its own
  recordings make-meeting <rid> --title "…"
                                  A meeting of its own (no calendar event)
  recordings keep <rid>           Remove the expiry of a temporary recording
                                  (it stays a private recording)
  recordings dismiss <rid>        "Not this" on the suggested calendar event:
                                  it is no longer offered (link any event by
                                  hand with 'recordings link')
  recordings rm <rid>             Delete it (refused while a meeting uses it)

TRANSCRIPTION VERSIONS of a recording that is in no meeting (same verbs and
flags as 'darth-cli meetings transcriptions|text --version|transcribe-again|
merge-transcriptions|use-transcription' — see 'darth-cli meetings --help'):
  recordings transcriptions <rid> Versions, ▶ active, HEALTH + next command
  recordings text <rid> --version <tid>
                                  Read a version that is not active
  recordings transcribe-again <rid> [--language <code|auto|auto-en>] [--model <m>]
         [--reason "…"] [--keep-active | --merge] [--merge-threshold 0.75]
         [--force] [--wait [--timeout <mins>]]
  recordings merge-transcriptions <rid> --base <tid> --fill <tid> [--threshold 0.75]
         [--reason "…"] [--dry-run] [--activate]
  recordings use-transcription <rid> <tid>
                                  The writes are refused (409) once a meeting
                                  uses the recording — the CLI prints the
                                  meeting id; use the meeting verbs there

<rid> = the recording uuid; 'rec-<uuid>' is accepted too.`;

/** 'rec-<uuid>' | '<uuid>' → '<uuid>'. */
function recId(raw: string): string {
  return raw.trim().replace(/^rec-/i, "");
}

/** Meet code, exact event key or Teams ref → event; anything else → meeting id. */
function isEventRef(ref: string): boolean {
  return ref.includes("|") || /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(ref) || ref.startsWith("teams-");
}

function fmtDay(iso: string | null | undefined, tz: string): string {
  if (!iso) return "?";
  return fmtLocalDateTime(iso, tz).slice(0, 10);
}

/** The id a list item is addressed by + its printable line. */
function recordingItemLine(item: any, tz: string): { id: string; line: string } {
  const when = (iso: string | null | undefined) => (iso ? fmtLocalDateTime(iso, tz) : "?");
  if (item.kind === "recording") {
    const r = item.recording ?? {};
    const at = r.started_at || r.created_at;
    const title = r.title || `Recording · ${when(at)}`;
    const exp = r.temporary && r.expires_at ? `  expires ${fmtDay(r.expires_at, tz)}` : "";
    // section=linked items name the meeting(s) they are in; elsewhere a bare flag.
    const linkedTo = Array.isArray(item.meetings) && item.meetings.length
      ? `  (in meeting ${item.meetings.map((m: any) => m.title ? `${m.assemblyai_id} "${m.title}"` : m.assemblyai_id).join(", ")})`
      : "";
    const inMtg = linkedTo || (r.in_meeting ? "  (in a meeting)" : "");
    return { id: r.id, line: `${r.id}  ${when(at)}  ${fmtDuration(r.duration_sec ?? null).padStart(7)}  ${String(r.status).padEnd(12)}  ${title}${inMtg}${exp}` };
  }
  if (item.kind === "meeting") {
    const t = item.row ?? {};
    const at = t.recorded_at || t.created_at;
    const title = t.title || t.original_filename || `Recording · ${when(at)}`;
    let exp = "";
    if (item.section === "temporary") {
      const e = t.expires_at || (t.created_at ? new Date(Date.parse(t.created_at) + 30 * 86400_000).toISOString() : null);
      if (e) exp = `  expires ${fmtDay(e, tz)}`;
    }
    return { id: t.assemblyai_id, line: `${t.assemblyai_id}  ${when(at)}  ${fmtDuration(t.duration ?? null).padStart(7)}  ${String(t.status).padEnd(12)}  ${title}  (legacy meeting row)${exp}` };
  }
  const g = item.registry ?? {};
  const title = g.call?.title || `Recording · ${when(g.started_at)}`;
  return { id: g.id, line: `${g.id}  ${when(g.started_at)}  ${fmtDuration(g.duration_s ?? null).padStart(7)}  ${String(g.status).padEnd(12)}  ${title}  (on your Mac — upload from the tray)` };
}

function printRecordingView(v: any, tz: string): void {
  const when = (iso: string | null | undefined) => (iso ? fmtLocalDateTime(iso, tz) : "?");
  console.log(`id:         ${v.id}  (${v.pseudo_id ?? `rec-${v.id}`})`);
  console.log(`title:      ${v.title || `Recording · ${when(v.started_at || v.created_at)}`}`);
  console.log(`status:     ${v.status}${v.status_note ? ` — ${v.status_note}` : ""}`);
  if (v.upload && v.status === "uploading") console.log(`upload:     ${fmtMB(v.upload.bytes_received ?? 0)} of ${fmtMB(v.upload.bytes_total ?? 0)} MB`);
  console.log(`recorded:   ${when(v.started_at)}  (uploaded ${when(v.created_at)})`);
  console.log(`duration:   ${fmtDuration(v.duration_sec ?? null)}  speakers: ${v.speaker_count ?? "?"}  language: ${v.language_code ?? "?"}`);
  const media = [
    v.source_kind,
    v.original_filename,
    v.bytes != null ? `${fmtMB(v.bytes)} MB` : null,
    v.has_video ? "video" : "audio",
    v.part_count > 1 ? `${v.part_count} parts` : null,
  ].filter(Boolean).join(" · ");
  console.log(`media:      ${media}`);
  if (v.temporary && v.expires_at) console.log(`expires:    ${fmtDay(v.expires_at, tz)}  (keep with: darth-cli meetings recordings keep ${v.id})`);
  for (const m of v.meetings ?? []) console.log(`in meeting: ${m.id} ${m.title || "(untitled)"}${m.trashed ? "  [trashed]" : ""}`);
  const s = v.suggested_event;
  if (s) console.log(`suggested event: ${s.title || "(untitled)"} · ${when(s.startIso)}  (link with: darth-cli meetings recordings link ${v.id} '${s.key}')`);
  if (!v.in_meeting) console.log("private to you, not shared — 'recordings link' / 'recordings make-meeting', then share the meeting");
}

/** Non-2xx on a recordings write → a readable line; returns the exit code. */
function recordingWriteError(verb: string, status: number, data: any): number {
  const msg = data?.error ?? `HTTP ${status}`;
  if (status === 401) console.error(`Unauthorized: ${msg}\nYour token may be expired/revoked — run: darth-cli login`);
  else if (status === 403) console.error(`Forbidden: ${msg}\nWrite commands need a read+write token for meetings — re-run 'darth-cli login' and pick Read + write.`);
  else if (status === 404) console.error(`${verb} failed: no such recording of yours (${msg}).`);
  else if (status === 409 && data?.code === "not-ready") console.error(`${verb} failed: still transcribing (${msg}) — try again once 'recordings get' says ready.`);
  else if (status === 409 && data?.code === "already-linked") console.error(`${verb} failed: already in a meeting (${msg}).`);
  else if (status === 409 && data?.code === "in-meeting") console.error(`${verb} refused: a meeting uses this recording (${msg}) — it goes with the meeting.`);
  else console.error(`${verb} failed (HTTP ${status}): ${msg}${data?.code ? ` [${data.code}]` : ""}`);
  return status === 401 ? 3 : 1;
}

async function recordingRequest(ctx: Ctx, path: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await ctx.api("meetings", path, init);
  const data = await readJsonSafe(res);
  return { ok: res.ok, status: res.status, data };
}

/** Download to a file, streamed (recordings can be multi-GB video). */
async function downloadStreamed(ctx: Ctx, path: string, outFile: string | undefined, fallbackName: string): Promise<number> {
  const res = await ctx.api("meetings", path);
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error || msg; } catch {}
    console.error(`Error (HTTP ${res.status}): ${msg}`);
    return res.status === 401 ? 3 : 1;
  }
  const type = (res.headers.get("content-type") || "").split(";")[0]!.trim();
  const out = outFile || `${fallbackName}.${EXT_BY_TYPE[type] || "bin"}`;
  const B: any = (globalThis as any).Bun;
  const bytes: number = B?.write ? await B.write(out, res) : (writeFileSync(out, Buffer.from(await res.arrayBuffer())), statSync(out).size);
  console.log(`${out}  (${bytes} bytes, ${type || "unknown type"})`);
  return 0;
}

/** Upload answered with a recording (born bare): its uuid, else null. */
function bornBareId(t: any, fallbackId?: string): string | null {
  const pid = String(t?.assemblyai_id ?? fallbackId ?? "");
  if (t?.recording_id && (t.born_bare === true || pid.startsWith("rec-"))) return String(t.recording_id);
  if (pid.startsWith("rec-")) return pid.slice(4);
  return null;
}

/** Poll GET /api/recordings/:id until ready/failed. Null on failure/timeout. */
async function waitForRecording(ctx: Ctx, rid: string, capMin: number, say: (l: string) => void): Promise<any | null> {
  const deadline = Date.now() + capMin * 60_000;
  say(`Waiting for transcription (up to ${capMin} min, poll 10s)…`);
  while (Date.now() < deadline) {
    await sleep(10_000);
    const res = await ctx.api("meetings", `/api/recordings/${rid}`);
    if (res.status === 404) { console.error(`Recording ${rid} vanished — check the web app.`); return null; }
    const j = await readJsonSafe(res);
    const v = j?.recording;
    if (!res.ok || !v) continue;
    if (v.status === "failed") { console.error(`Transcription failed: ${v.status_note ?? "see the web app"}`); return null; }
    if (v.status === "ready") return v;
  }
  console.error(`Still transcribing after ${capMin} min — it keeps running server-side; check later with 'darth-cli meetings recordings get ${rid}'.`);
  return null;
}

// ---------------------------------------------------------------------------
// segments — a meeting is a timeline of segments (server name: clips).
// A segment = [from, to) of ONE recording placed at `at` on the meeting's
// timeline, with a text policy. Thin wrappers over /api/transcripts/:id/clips*,
// /split, /unsplit and /api/recordings/:id/align (lib/clips.ts contracts).
// ---------------------------------------------------------------------------

const SEGMENTS_HELP = `darth-cli meetings segments — a meeting is a TIMELINE of segments; a segment is a
window of one recording placed at a time on that timeline (server name: clip)

USAGE
  darth-cli meetings segments <meeting> [--json]
  darth-cli meetings segments <verb> <meeting> … [--json]

READ
  segments <meeting>              The timeline: every segment (#n, recording,
                                  window from→to, placed at, text policy,
                                  source, owner), the meeting's span, holes,
                                  sibling meetings on the same recording and
                                  what you may do next (split / add / unsplit)
  segments candidates <meeting> [--all]
                                  Recordings you could add: your own, linked
                                  or not (only your OWN bytes are addable — a
                                  recording is private to its owner); --all
                                  also lists colleagues' recordings of
                                  meetings you edit, which they must add
  segments propose <meeting> [--instruction "…"]
                                  Ask the server for split windows: speaker
                                  joins/leaves, long silences, calendar
                                  boundaries, then an agent reads them.
                                  Proposals only — nothing changes

WRITE (needs read+write for meetings; you must be able to EDIT the meeting)
  segments add <meeting> <rid> [--from T] [--to T] [--at T] [--text include|gap-fill|exclude]
                                  Add a window of one of YOUR recordings
                                  (default: all of it), placed at --at on the
                                  meeting's timeline (default 0:00 = starts
                                  with the meeting). The server never guesses
                                  the place — measure it with 'segments align'.
                                  --text include = its words merge by time
                                  (two mics, one room); gap-fill = its words
                                  only where no other segment has speech;
                                  exclude = playable audio, contributes no text
  segments edit <meeting> <n> [--from T] [--to T] [--at T] [--text …]
                                  Change segment #n's window, place or policy
  segments rm <meeting> <n>       Remove segment #n (the last one cannot go)
  segments align <rid> --against <rid2> [--near T] [--window T]
                                  Measure how far <rid> starts AFTER <rid2> by
                                  cross-correlating the audio (negative = it
                                  started first). Prints offset + confidence;
                                  applies NOTHING — pass the offset as --at
                                  when <rid2> is the meeting's first segment.
                                  --near = where to look first, --window =
                                  half-width of the search (default ±2 min
                                  with --near, ±30 min without). Slow on
                                  long files (minutes)

  split <meeting> --from T --to T [--title …] [--event <ref>] [--keep-in-both] [--no-wait]
  unsplit <meeting>               Top-level verbs — 'darth-cli meetings --help'

T = mm:ss, h:mm:ss or plain ms. <rid> = recording uuid ('rec-<uuid>' accepted).
<meeting> = a meeting id (the ids 'list' prints). Segments of a meeting are
numbered #0, #1, … in the order 'segments <meeting>' prints them.`;

/** ms → m:ss, or h:mm:ss past the hour (what the web UI prints). */
function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "?";
  const neg = ms < 0;
  const total = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const body = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

/** A --from/--to/--at value as the server takes it: mm:ss / h:mm:ss / ms strings pass through. */
function timeFlag(flags: Record<string, string | boolean>, name: string): string | null | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (raw === true) { console.error(`--${name} needs a value (mm:ss, h:mm:ss or ms)`); return null; }
  const v = String(raw).trim();
  if (!/^([0-9]+|[0-9]{1,3}:[0-5]?[0-9](:[0-5]?[0-9])?(\.[0-9]{1,3})?)$/.test(v)) { console.error(`--${name}: '${v}' is not mm:ss, h:mm:ss or ms`); return null; }
  return v;
}

/** --text include|gap-fill|exclude → the server's policy name. */
function textPolicyFlag(flags: Record<string, string | boolean>): string | null | undefined {
  const raw = flags.text;
  if (raw === undefined) return undefined;
  const v = String(raw).trim().toLowerCase().replace("-", "_");
  if (!["include", "gap_fill", "exclude"].includes(v)) { console.error("--text must be include, gap-fill or exclude"); return null; }
  return v;
}

/** Non-2xx on a segments/split write → a readable line; returns the exit code. */
function segmentWriteError(verb: string, status: number, data: any): number {
  const msg = data?.error ?? `HTTP ${status}`;
  const code = data?.code ? ` [${data.code}]` : "";
  if (status === 401) console.error(`Unauthorized: ${msg}\nYour token may be expired/revoked — run: darth-cli login`);
  else if (status === 403) console.error(`Forbidden: ${msg}\nYou need EDIT access to the meeting and a read+write token (re-run 'darth-cli login' and pick Read + write).`);
  else if (status === 404 && data?.code === "disabled") console.error(`${verb} is not available on this server (${msg}).`);
  else if (status === 404) console.error(`${verb} failed: not found (${msg})${code} — the meeting id, the recording, or the segment number.`);
  else console.error(`${verb} refused (HTTP ${status}): ${msg}${code}`);
  return status === 401 ? 3 : 1;
}

function printSegmentEntries(entries: any[], spanMs: number | null): void {
  for (const e of entries) {
    const win = `${fmtMs(e.fromMs)} → ${e.toMs === null || e.toMs === undefined ? "end" : fmtMs(e.toMs)}`;
    const dur = e.durationMs != null ? ` (${fmtMs(e.durationMs)})` : "";
    const who = e.mine ? "yours" : (e.ownerName || e.ownerEmail || "someone else's");
    const tags = [e.primary ? "primary" : null, e.transcribed === false ? "text pending" : null, e.alignment ? e.alignment : null].filter(Boolean);
    console.log(`#${e.ord}  rec ${e.recordingId}  ${win}${dur}  at ${fmtMs(e.offsetMs)}  ${String(e.textPolicy ?? "include").replace("_", "-")}  ${e.sourceLabel ?? ""}  (${who})${tags.length ? `  [${tags.join(", ")}]` : ""}`);
  }
  if (spanMs != null) console.log(`span: ${fmtMs(spanMs)}`);
}

function printSegmentsView(mid: string, v: any, ctx: Ctx): void {
  if (v.enabled === false) {
    console.log(`meeting ${mid}: segments are not enabled for this meeting on this server (legacy row without a recording, or the feature is off).`);
    return;
  }
  const entries: any[] = Array.isArray(v.entries) && v.entries.length ? v.entries : (v.clips ?? []).map((c: any) => ({ ...c, sourceLabel: "", mine: true }));
  console.log(`meeting ${mid}  ${v.canEdit ? "(you can edit)" : "(read-only)"}  recordings: ${v.recordingCount ?? 1}  web: ${webBase(ctx)}/transcript/${mid}`);
  if (v.recording) console.log(`recording: ${v.recording.id}  ${fmtMs(v.recording.durationMs)}${v.recording.startedAt ? `  started ${fmtLocalDateTime(v.recording.startedAt, localTz(ctx))}` : ""}`);
  printSegmentEntries(entries, v.spanMs ?? null);
  if (v.window) console.log(`plays: ${fmtMs(v.window.fromMs)} → ${v.window.toMs === null ? "end" : fmtMs(v.window.toMs)} of the recording`);
  for (const h of v.holes ?? []) console.log(`hole: ${fmtMs(h.fromMs)} → ${fmtMs(h.toMs)}  (split off, not in this meeting)`);
  if (v.splitFrom) console.log(`split from: ${v.splitFrom.meetingId ?? "?"} ${v.splitFrom.title ? `"${v.splitFrom.title}"` : ""}  ${v.splitFrom.url ? (String(v.splitFrom.url).startsWith("/") ? webBase(ctx) + v.splitFrom.url : v.splitFrom.url) : ""}`);
  for (const s of v.siblings ?? []) {
    const rel = s.isSplitOff ? "split off this one" : s.isSource ? "this one was split off it" : "same recording";
    console.log(`sibling: ${s.id} ${s.title ? `"${s.title}"` : "(untitled)"}  ${fmtMs(s.fromMs)} → ${s.toMs === null ? "end" : fmtMs(s.toMs)}  (${rel}${s.trashed ? ", trashed" : ""})`);
  }
  for (const p of v.pendingAttach ?? []) console.log(`pending: a recording is being added (${p.sourceLabel ?? p.status ?? "upload"})`);
  const next: string[] = [];
  next.push(v.splittable ? `split: ok  (darth-cli meetings split ${mid} --from T --to T)` : `split: no — ${v.splitBlockedReason ?? "not splittable"}`);
  if (v.combineEnabled !== undefined) next.push(v.canAddRecording ? `add a recording: ok  (darth-cli meetings segments add ${mid} <rid>)` : `add a recording: no — ${v.addBlockedReason ?? (v.combineEnabled ? "not now" : "combining is off on this server")}`);
  next.push(v.canUnsplit ? `unsplit: ok  (darth-cli meetings unsplit ${mid})` : `unsplit: no${v.unsplitBlockedReason ? ` — ${v.unsplitBlockedReason}` : ""}`);
  for (const n of next) console.log(n);
}

async function segmentsCmd(ctx: Ctx, flags: Record<string, string | boolean>, pos: string[]): Promise<number> {
  liftBoolFlags(pos, flags, ["all"]);
  const [first, ...rest] = pos;
  if (!first || first === "help" || flags.help === true) { console.log(SEGMENTS_HELP); return 0; }
  const VERBS = ["list", "ls", "candidates", "propose", "add", "edit", "rm", "align"];
  // 'segments <meeting>' = list; 'segments <verb> <meeting> …' otherwise.
  const sub = VERBS.includes(first) ? first : "list";
  const args = VERBS.includes(first) ? rest : [first, ...rest];
  const need = (n: number, usage: string): boolean => {
    if (args.length < n || args.slice(0, n).some(a => !a)) { console.error(`usage: darth-cli meetings segments ${usage}`); return false; }
    return true;
  };

  switch (sub) {
    case "list":
    case "ls": {
      if (!need(1, "<meeting>")) return 1;
      const mid = args[0]!;
      const r = await recordingRequest(ctx, `/api/transcripts/${mid}/clips`, { method: "GET" });
      if (!r.ok) return segmentWriteError("segments", r.status, r.data);
      ctx.print(r.data, () => printSegmentsView(mid, r.data, ctx));
      return 0;
    }

    case "candidates": {
      if (!need(1, "candidates <meeting>")) return 1;
      const mid = args[0]!;
      const r = await recordingRequest(ctx, `/api/transcripts/${mid}/clips/candidates`, { method: "GET" });
      if (!r.ok) return segmentWriteError("segments candidates", r.status, r.data);
      ctx.print(r.data, () => {
        const v = r.data;
        if (v.enabled === false) { console.log("Adding recordings is not available for this meeting (combining off, or the meeting has no segment yet)."); return; }
        const all: any[] = v.candidates ?? [];
        const addable = all.filter((c: any) => c.addable);
        const shown = flags.all === true ? all : addable;
        console.log(`meeting ${mid}: ${addable.length} addable recording(s) of yours${all.length > addable.length ? ` (+${all.length - addable.length} of colleagues — only their owner can add those${flags.all === true ? "" : "; --all lists them"})` : ""}, ${v.slotsLeft ?? "?"} slot(s) left${v.canEdit ? "" : "  (read-only — you cannot add)"}`);
        for (const c of shown) {
          const who = c.mine ? "yours" : (c.ownerName || c.ownerEmail || "someone else's");
          const where = c.meeting ? `in meeting ${c.meeting.id} ${c.meeting.title ? `"${c.meeting.title}"` : ""}` : (c.unlinked ? "not in any meeting" : "");
          const nominal = c.nominalOffsetMs != null ? `  nominal at ${fmtMs(c.nominalOffsetMs)}` : "";
          console.log(`${c.recordingId}  ${fmtMs(c.durationMs)}  ${c.startedAt ? fmtLocalDateTime(c.startedAt, localTz(ctx)) : "?"}  ${c.sourceLabel ?? ""}  (${who}${c.transcribed ? "" : ", not transcribed"})  ${where}${nominal}${c.addable ? "" : `  — cannot add: ${c.blockedReason ?? "not yours"}`}`);
        }
      });
      return 0;
    }

    case "propose": {
      if (!need(1, "propose <meeting> [--instruction \"…\"]")) return 1;
      const mid = args[0]!;
      const instruction = str(flags.instruction);
      const r = await recordingRequest(ctx, `/api/transcripts/${mid}/clips/propose`, { method: "POST", body: JSON.stringify(instruction ? { instruction } : {}) });
      if (!r.ok) return segmentWriteError("segments propose", r.status, r.data);
      ctx.print(r.data, () => {
        const v = r.data;
        console.log(`${v.candidates ?? 0} boundary candidate(s) found${v.ranAgent ? ", agent ran" : ", no agent call"}; ${v.proposals?.length ?? 0} proposal(s):`);
        for (const p of v.proposals ?? []) {
          console.log(`  ${fmtMs(p.fromMs)} → ${fmtMs(p.toMs)}  "${p.title}"  (${Math.round((p.confidence ?? 0) * 100)}%${p.basis ? `, ${p.basis}` : ""})  ${p.reason ?? ""}`);
          console.log(`    darth-cli meetings split ${mid} --from ${fmtMs(p.fromMs)} --to ${fmtMs(p.toMs)} --title ${JSON.stringify(p.title)}${p.eventRef ? ` --event '${p.eventRef}'` : ""}`);
        }
        if (!(v.proposals?.length)) console.log("  (none — no strong boundary; give an --instruction or pick the window by hand from 'text')");
      });
      return 0;
    }

    case "add": {
      if (!need(2, "add <meeting> <rid> [--from T] [--to T] [--at T] [--text include|gap-fill|exclude]")) return 1;
      ctx.requireWrite();
      const mid = args[0]!, rid = recId(args[1]!);
      const from = timeFlag(flags, "from"), to = timeFlag(flags, "to"), at = timeFlag(flags, "at"), text = textPolicyFlag(flags);
      if (from === null || to === null || at === null || text === null) return 1;
      const body: Record<string, unknown> = { recordingId: rid };
      if (from !== undefined) body.from = from;
      if (to !== undefined) body.to = to;
      if (at !== undefined) body.offset = at;
      if (text !== undefined) body.textPolicy = text;
      const r = await recordingRequest(ctx, `/api/transcripts/${mid}/clips`, { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) return segmentWriteError("segments add", r.status, r.data);
      ctx.print(r.data, () => {
        console.log(`added → meeting ${mid} now holds ${r.data.recordingCount ?? "?"} recording(s), ${r.data.clips?.length ?? "?"} segment(s); text re-built: ${r.data.materialised?.utterances ?? "?"} utterances, ${r.data.materialised?.speakerCount ?? "?"} speakers`);
        printSegmentEntries(r.data.clips ?? [], r.data.spanMs ?? null);
      });
      return 0;
    }

    case "edit": {
      if (!need(2, "edit <meeting> <n> [--from T] [--to T] [--at T] [--text …]")) return 1;
      ctx.requireWrite();
      const mid = args[0]!, ord = args[1]!.replace(/^#/, "");
      if (!/^\d+$/.test(ord)) { console.error("segment number must be the #n from 'segments <meeting>'"); return 1; }
      const from = timeFlag(flags, "from"), to = timeFlag(flags, "to"), at = timeFlag(flags, "at"), text = textPolicyFlag(flags);
      if (from === null || to === null || at === null || text === null) return 1;
      const body: Record<string, unknown> = {};
      if (from !== undefined) body.from = from;
      if (to !== undefined) body.to = to;
      if (at !== undefined) body.offset = at;
      if (text !== undefined) body.textPolicy = text;
      if (!Object.keys(body).length) { console.error("nothing to change — give --from, --to, --at or --text"); return 1; }
      const r = await recordingRequest(ctx, `/api/transcripts/${mid}/clips/${ord}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!r.ok) return segmentWriteError("segments edit", r.status, r.data);
      ctx.print(r.data, () => {
        console.log(`segment #${ord} updated; text re-built: ${r.data.materialised?.utterances ?? "?"} utterances`);
        printSegmentEntries(r.data.clips ?? [], r.data.spanMs ?? null);
      });
      return 0;
    }

    case "rm": {
      if (!need(2, "rm <meeting> <n>")) return 1;
      ctx.requireWrite();
      const mid = args[0]!, ord = args[1]!.replace(/^#/, "");
      if (!/^\d+$/.test(ord)) { console.error("segment number must be the #n from 'segments <meeting>'"); return 1; }
      const r = await recordingRequest(ctx, `/api/transcripts/${mid}/clips/${ord}`, { method: "DELETE" });
      if (!r.ok) return segmentWriteError("segments rm", r.status, r.data);
      ctx.print(r.data, () => {
        console.log(`segment #${ord} removed; meeting ${mid} now holds ${r.data.recordingCount ?? "?"} recording(s), ${r.data.clips?.length ?? "?"} segment(s)`);
        printSegmentEntries(r.data.clips ?? [], r.data.spanMs ?? null);
      });
      return 0;
    }

    case "align": {
      if (!need(1, "align <rid> --against <rid2> [--near T] [--window T]")) return 1;
      const rid = recId(args[0]!);
      const against = str(flags.against);
      if (!against) { console.error("usage: darth-cli meetings segments align <rid> --against <rid2> [--near T] [--window T]"); return 1; }
      const near = timeFlag(flags, "near"), window = timeFlag(flags, "window");
      if (near === null || window === null) return 1;
      const body: Record<string, unknown> = { against: recId(against) };
      // the align route takes ms numbers only
      const toMs = (v: string): number => {
        if (/^[0-9]+$/.test(v)) return Number(v);
        const p = v.split(":").map(Number);
        const [h, m, s] = p.length === 3 ? p : [0, p[0], p[1]];
        return Math.round(((h! * 60 + m!) * 60 + s!) * 1000);
      };
      if (near !== undefined) body.nominalOffsetMs = toMs(near);
      if (window !== undefined) body.searchWindowMs = toMs(window);
      console.error("Measuring (decoding both recordings — minutes on long files)…");
      const r = await recordingRequest(ctx, `/api/recordings/${rid}/align`, { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) return segmentWriteError("segments align", r.status, r.data);
      ctx.print(r.data, () => {
        const v = r.data;
        const pct = Math.round((v.confidence ?? 0) * 100);
        const verdict = (v.confidence ?? 0) >= 0.4 ? "usable" : "too weak — set it by ear";
        console.log(`${rid} starts ${fmtMs(Math.abs(v.offsetMs))} ${v.offsetMs < 0 ? "BEFORE" : "after"} ${recId(against)}  (offset ${v.offsetMs} ms, confidence ${pct}% ${verdict}${v.driftPpm != null ? `, drift ${v.driftPpm} ppm` : ""}${v.overlapMs != null ? `, overlap ${fmtMs(v.overlapMs)}` : ""})`);
        if (v.advice) console.log(v.advice);
        if (v.offsetMs >= 0) console.log(`If ${recId(against)} is the meeting's first segment at 0:00: darth-cli meetings segments add <meeting> ${rid} --at ${fmtMs(v.offsetMs)}`);
        else console.log(`It started first: add it at 0:00 and move the other segment to --at ${fmtMs(-v.offsetMs)} ('segments edit').`);
      });
      return 0;
    }

    default:
      console.error(`Unknown segments command: ${sub}\n`);
      console.log(SEGMENTS_HELP);
      return 1;
  }
}

/**
 * The server answers 409 `speaker_check_running` while the speaker-ID pass
 * runs on the meeting (a half split off mid-pass would inherit 'running' and
 * wait for names forever). The pass takes about a minute, so `split` waits:
 * one line, retry every `intervalMs`, give up after `maxMs`. Exported so the
 * tests can shorten the clock; the CLI itself never changes these.
 */
export const SPLIT_RETRY = { intervalMs: 10_000, maxMs: 180_000 };

type SplitReply = { ok: boolean; status: number; data: { code?: unknown; error?: unknown } | null };

const isSpeakerCheckRunning = (r: SplitReply): boolean =>
  r.status === 409 && r.data?.code === "speaker_check_running";

/**
 * Sends the split; on 409 speaker_check_running waits and re-sends until the
 * server accepts, answers something else, or `SPLIT_RETRY.maxMs` has passed
 * (the last reply — the 409 — is returned, so the caller prints the server's
 * own sentence). `wait: false` returns the first reply as is.
 */
async function splitWithRetry(mid: string, send: () => Promise<SplitReply>, wait: boolean): Promise<SplitReply> {
  const started = Date.now();
  let r = await send();
  while (wait && isSpeakerCheckRunning(r)) {
    const elapsed = Date.now() - started;
    if (elapsed + SPLIT_RETRY.intervalMs > SPLIT_RETRY.maxMs) break;
    console.error(`speaker identification is still running on ${mid} — retrying in ${Math.round(SPLIT_RETRY.intervalMs / 1000)} s (up to ${Math.round(SPLIT_RETRY.maxMs / 60_000)} min in all; --no-wait fails at once)`);
    await sleep(SPLIT_RETRY.intervalMs);
    r = await send();
  }
  return r;
}

/** darth-cli meetings split <meeting> --from T --to T [--title] [--event <ref>] [--keep-in-both] [--no-wait] */
async function splitCmd(ctx: Ctx, flags: Record<string, string | boolean>, args: string[]): Promise<number> {
  const mid = args[0];
  const usage = "usage: darth-cli meetings split <meeting> --from T --to T [--title \"…\"] [--event <meeting-code|event-key>] [--keep-in-both] [--no-wait]   (T = mm:ss, h:mm:ss or ms, on the MEETING's timeline)";
  if (!mid) { console.error(usage); return 1; }
  const from = timeFlag(flags, "from"), to = timeFlag(flags, "to");
  if (from === null || to === null) return 1;
  if (from === undefined || to === undefined) { console.error(usage); return 1; }
  ctx.requireWrite();
  const body: Record<string, unknown> = { from, to };
  const title = str(flags.title);
  if (title) body.title = title;
  const ev = str(flags.event);
  if (ev) body.eventRef = ev;
  if (flags["keep-in-both"] === true) body.keepInBoth = true;
  const r = await splitWithRetry(
    mid,
    () => recordingRequest(ctx, `/api/transcripts/${mid}/split`, { method: "POST", body: JSON.stringify(body) }),
    flags["no-wait"] !== true
  );
  if (!r.ok) {
    if (isSpeakerCheckRunning(r) && flags["no-wait"] !== true) console.error(`gave up after ${Math.round(SPLIT_RETRY.maxMs / 60_000)} min — the speaker pass is still running on ${mid}; 'darth-cli meetings speakers ${mid}' shows it, or name every speaker with set-speakers to end it.`);
    const code = segmentWriteError("split", r.status, r.data);
    if (r.status === 404 && ev) console.error("Tip: 'darth-cli meetings calendar --view all --json' lists your events with their [meeting-code] and exact 'key'.");
    return code;
  }
  ctx.print(r.data, () => {
    const m = r.data.meeting ?? {};
    console.log(`split → new meeting ${m.id} ${m.title ? `"${m.title}"` : "(untitled)"}  ${fmtMs(m.fromMs)} → ${fmtMs(m.toMs)} of the recording (${fmtMs(m.durationMs)})`);
    console.log(`Web: ${webBase(ctx)}/transcript/${m.id}`);
    const mv = r.data.moved ?? {};
    if (mv.edits || mv.speakerNames) console.log(`moved with it: ${mv.edits ?? 0} text edit(s), ${mv.speakerNames ?? 0} speaker name(s)`);
    if (r.data.linkedEvent) console.log(`linked to "${r.data.linkedEvent.title ?? "(untitled)"}" ${r.data.linkedEvent.startTime ? fmtLocalDateTime(r.data.linkedEvent.startTime, localTz(ctx)) : ""} — shared with ${r.data.linkedEvent.shared ?? 0} Trames invitee(s)`);
    if (flags["keep-in-both"] === true) console.log(`source ${mid} keeps the window too (--keep-in-both)`);
    else console.log(`source ${mid} now has a hole there${r.data.source?.notesStale ? " — its notes/report were written before the split; regenerate them in the web UI" : ""}`);
    console.log(`undo: darth-cli meetings unsplit ${m.id}`);
  });
  return 0;
}

/** darth-cli meetings unsplit <meeting> — from the SPLIT-OFF meeting. */
async function unsplitCmd(ctx: Ctx, args: string[]): Promise<number> {
  const mid = args[0];
  if (!mid) { console.error("usage: darth-cli meetings unsplit <split-off-meeting-id>   (the id 'split' printed; the window goes back into its source meeting)"); return 1; }
  ctx.requireWrite();
  const r = await recordingRequest(ctx, `/api/transcripts/${mid}/unsplit`, { method: "POST" });
  if (!r.ok) return segmentWriteError("unsplit", r.status, r.data);
  ctx.print(r.data, () => {
    const m = r.data.meeting ?? {};
    console.log(`put back → ${mid} is gone; its window is part of ${m.id} ${m.title ? `"${m.title}"` : ""} again${r.data.restored?.edits ? ` (${r.data.restored.edits} edit(s) restored)` : ""}`);
    console.log(`Web: ${webBase(ctx)}/transcript/${m.id}`);
  });
  return 0;
}

// ---------------------------------------------------------------------------
// Transcription versions (docs/transcription-merge-spec.md §4). A recording
// holds many transcriptions (versions); one is active and the meeting shows
// it. These verbs list them (with a health signal), read a non-active one,
// run another pass (replace / keep as helper / merge), merge two versions,
// and switch the active one. Same five verbs on a meeting
// (/api/transcripts/:id/…) and on a bare recording (/api/recordings/:rid/…,
// owner only; 409 {meetingId} when a meeting uses it).
// ---------------------------------------------------------------------------

/** Where a family of version verbs points: a meeting or a bare recording. */
interface VersionScope {
  kind: "meeting" | "recording";
  id: string;
  /** '/api/transcripts/<id>' | '/api/recordings/<rid>' */
  base: string;
  /** The run route under base: 'retranscribe' (meeting) | 'transcribe' (recording). */
  runRoute: string;
  /** Command prefix for printed next steps. */
  cmd: string;
}

function versionScope(kind: "meeting" | "recording", rawId: string): VersionScope {
  if (kind === "meeting") {
    return { kind, id: rawId, base: `/api/transcripts/${encodeURIComponent(rawId)}`, runRoute: "retranscribe", cmd: "darth-cli meetings" };
  }
  const id = recId(rawId);
  return { kind, id, base: `/api/recordings/${encodeURIComponent(id)}`, runRoute: "transcribe", cmd: "darth-cli meetings recordings" };
}

const VERSION_VERBS = ["transcriptions", "transcribe-again", "merge-transcriptions", "use-transcription"] as const;
const VERSION_BOOL_FLAGS = ["keep-active", "merge", "force", "dry-run", "activate", "wait"] as const;
/** Default merge threshold (spec §1: utterance + rolling word mean). */
const MERGE_THRESHOLD_DEFAULT = 0.75;

const fmt2 = (n: number | null | undefined): string => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "?");
const pct = (n: number | null | undefined): string => (typeof n === "number" && Number.isFinite(n) ? `${Math.round(n * 100)}%` : "?");

/** Non-2xx on a version route → a readable line; returns the exit code. */
function versionError(sc: VersionScope, verb: string, status: number, data: any): number {
  // A non-JSON body (Next's HTML 404 page for a route this server lacks) is noise, not a message.
  const raw = data?.error;
  const msg = typeof raw === "string" && !/^\s*</.test(raw) ? raw : `HTTP ${status}${typeof raw === "string" ? ", no such route" : ""}`;
  if (status === 401) console.error(`Unauthorized: ${msg}\nYour token may be expired/revoked — run: darth-cli login`);
  else if (status === 403) console.error(`Forbidden: ${msg}\n${sc.kind === "meeting" ? "You need EDIT access to the meeting and" : "You need"} a read+write token for meetings (re-run 'darth-cli login' and pick Read + write).`);
  else if (status === 409 && data?.meetingId) {
    console.error(`${verb} refused: recording ${sc.id} is used by meeting ${data.meetingId} (${msg}).`);
    console.error(`Use the meeting's verbs — switching versions there moves the meeting's speaker names and edits too:  darth-cli meetings ${verb} ${data.meetingId} …`);
  } else if (status === 409 && data?.sameSettings) console.error(`${verb} refused: ${msg}\nThat would repeat the active version (same model + language) — add --force to run it anyway.`);
  else if (status === 409 && data?.running) {
    const r = data.running;
    console.error(`${verb} refused: a run is already in flight — version ${r.transcriptionId} (${r.speechModel ?? "?"}, language ${r.languageCode ?? "?"}) since ${r.startedAt ?? "?"}.`);
    console.error(`Follow it with: ${sc.cmd} transcriptions ${sc.id}`);
  } else if (status === 404) {
    console.error(sc.kind === "recording"
      ? `${verb} failed: no such recording of yours, or no such version of it (${msg}) — or this server does not have the recording-level transcription routes yet.`
      : `${verb} failed: not found (${msg}) — the meeting id or the version id; an older server may not have this route yet.`);
  } else if (status === 501) console.error(`${verb} is not available on this server yet (${msg}).`);
  else if (status === 400) console.error(`${verb} refused: ${msg}`);
  else console.error(`${verb} failed (HTTP ${status}): ${msg}${data?.code ? ` [${data.code}]` : ""}`);
  return status === 401 ? 3 : 1;
}

/** en, en_us, en-GB … (the side of a mixed call that is the merge BASE). */
function isEnglish(code: unknown): boolean {
  return typeof code === "string" && /^en([_-]|$)/i.test(code);
}

/** "en (detected 0.28)" | "id (forced)" | "en + id (merged)". */
function versionLanguage(v: any): string {
  const code = v.languageCode ?? "?";
  if (v.provider === "merge") return `${code} + ${v.merge?.fillLanguage ?? "?"} (merged)`;
  if (v.provider !== "assemblyai") return code;
  return v.languageDetected ? `${code} (detected ${fmt2(v.languageConfidence)})` : `${code} (forced)`;
}

/** "assemblyai universal-2 (asked universal-3-pro)" | "merge" | "teams-vtt". */
function versionEngine(v: any): string {
  if (v.provider !== "assemblyai") return String(v.provider ?? "?");
  const asked = v.speechModelRequested && v.speechModelRequested !== v.speechModel ? ` (asked ${v.speechModelRequested})` : "";
  return `assemblyai ${v.speechModel ?? "?"}${asked}`;
}

function mergeSummary(m: any): string {
  const s = m?.stats ?? {};
  const parts = [`base ${m?.base ?? "?"} + fill ${m?.fill ?? "?"} (${m?.fillLanguage ?? "?"})`];
  if (typeof s.utterances === "number") parts.push(`${s.utterancesTouched ?? "?"} of ${s.utterances} utterances replaced (${s.utterancesWhole ?? 0} whole)`);
  if (typeof s.swappedMs === "number") parts.push(`${fmtMs(s.swappedMs)} of ${fmtMs(s.durationMs)} audio swapped`);
  return parts.join(" · ");
}

function printVersionLine(v: any, tz: string): void {
  const who = v.requestedBy ? (v.requestedBy.name || v.requestedBy.email) : null;
  const when = v.completedAt || v.createdAt;
  const head = [
    `${v.active ? "▶" : " "} ${v.id}`,
    String(v.status ?? "?"),
    versionEngine(v),
    versionLanguage(v),
    `ASR ${fmt2(v.asrConfidence)}`,
    `${v.speakerCount ?? "?"} speakers`,
    when ? fmtLocalDateTime(when, tz) : "?",
  ];
  console.log(`${head.join("  ")}${who ? `  by ${who}` : ""}${v.reason ? `  — "${v.reason}"` : ""}`);
  if (v.merge) console.log(`      merge: ${mergeSummary(v.merge)}`);
  if (v.editsSetAside || v.speakerNamesSetAside) console.log(`      set aside with it: ${v.editsSetAside ?? 0} edit(s), ${v.speakerNamesSetAside ?? 0} speaker name(s) — they come back when it is active again`);
  if (v.status === "error" && v.error) console.log(`      error: ${v.error}`);
}

/** HEALTH line for the active version + the exact next command when it looks mixed-language. */
function printVersionHealth(sc: VersionScope, data: any): void {
  const versions: any[] = data.versions ?? [];
  const active = versions.find((v) => v.active);
  if (!active) { console.log("HEALTH: no active version"); return; }
  const h = active.health;
  if (!h) {
    console.log(`HEALTH (active ${active.id}): not reported${active.status !== "completed" ? ` — the version is ${active.status}` : " by this server for this version"}${active.asrConfidence != null ? ` (ASR ${fmt2(active.asrConfidence)})` : ""}`);
    return;
  }
  const facts = [
    `ASR ${fmt2(h.asrConfidence)}`,
    `language ${active.languageCode ?? "?"} conf ${fmt2(h.languageConfidence)}`,
    `low-confidence audio ${pct(h.lowConfidenceShare)}`,
    `foreign-script lines ${pct(h.foreignScriptShare)}`,
  ];
  console.log(`HEALTH (active ${active.id}): ${facts.join(" · ")} → ${h.mixedLanguageSuspected ? "MIXED LANGUAGE SUSPECTED" : "looks clean"}`);
  if (!h.mixedLanguageSuspected) return;
  if (active.provider === "merge" && active.merge) {
    console.log(`  the active version is already a merge — spot-check it ('${sc.cmd} text ${sc.id}'); to try another threshold:`);
    console.log(`  next: ${sc.cmd} merge-transcriptions ${sc.id} --base ${active.merge.base} --fill ${active.merge.fill} --threshold 0.8 --dry-run`);
    return;
  }
  const activeEn = isEnglish(active.languageCode);
  // A completed version on the other side of the language line already exists → merging it costs
  // nothing. Base = the English one (amendment A), fill = the other.
  const helper = versions.find((v) => !v.active && v.status === "completed" && v.provider !== "merge" && v.languageCode && isEnglish(v.languageCode) !== activeEn);
  if (helper) {
    const [b, f] = activeEn ? [active.id, helper.id] : [helper.id, active.id];
    console.log(`  a completed ${helper.languageCode} version already exists — merge it (no new transcription; base = the English one):`);
    console.log(`  next: ${sc.cmd} merge-transcriptions ${sc.id} --base ${b} --fill ${f} --dry-run`);
    return;
  }
  if (activeEn) {
    console.log(`  next: ${sc.cmd} transcribe-again ${sc.id} --language <code> --merge --wait`);
    console.log(`        <code> = the language you suspect besides English (e.g. id for Indonesian, zh for Chinese).`);
  } else {
    console.log(`  next: ${sc.cmd} transcribe-again ${sc.id} --language auto-en --merge --wait`);
    console.log(`        auto-en = an English base pass that keeps the ${active.languageCode ?? "other"} speech present; the merge then fills it from this version.`);
  }
  console.log(`        Never --language alone on a mixed call: forced en DROPS the other language's speech, a forced`);
  console.log(`        other language TRANSLATES the English. ~$0.17 per hour of audio per extra pass.`);
}

function printVersionsView(sc: VersionScope, data: any, tz: string): void {
  const versions: any[] = data.versions ?? [];
  const what = sc.kind === "meeting" ? `meeting ${sc.id}` : `recording ${sc.id}`;
  console.log(`transcriptions of ${what} — ${versions.length} version(s), newest first, ▶ = active${data.canEdit === false ? "  (read-only: you cannot run or switch versions)" : ""}`);
  if (data.versioned === false) console.log(`versions are not enabled for this ${sc.kind} (legacy path) — 'transcribe-again' would make a NEW meeting row here`);
  const tz2 = tz;
  for (const v of versions) printVersionLine(v, tz2);
  if (!versions.length) console.log("  (none)");
  const r = data.running;
  if (r) {
    const who = r.by ? (r.by.name || r.by.email) : null;
    console.log(`running: ${r.transcriptionId} — ${r.speechModel ?? "?"}, language ${r.languageCode ?? "?"}, since ${r.startedAt ? fmtLocalDateTime(r.startedAt, tz) : "?"}${who ? ` by ${who}` : ""}`);
  }
  if (data.notesStale) console.log(`notes/report: ${data.notesStale.reason ?? "written from the previous transcription"} — regenerate them in the web UI`);
  printVersionHealth(sc, data);
}

async function fetchVersions(ctx: Ctx, sc: VersionScope): Promise<{ ok: boolean; status: number; data: any }> {
  return recordingRequest(ctx, `${sc.base}/transcriptions`, { method: "GET" });
}

/** A threshold flag as a number in (0, 1); undefined when absent, null (printed) when bad. */
function thresholdFlag(flags: Record<string, string | boolean>, name: string): number | null | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const n = Number(raw === true ? NaN : raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) { console.error(`--${name} must be a number between 0 and 1 (default ${MERGE_THRESHOLD_DEFAULT})`); return null; }
  return n;
}

/** Diarization label ('A', 'B', '1') → "Speaker A"; a name passes through. */
function speakerDisplay(s: unknown): string {
  const t = String(s ?? "?");
  return /^[A-Z0-9]{1,2}$/.test(t) ? `Speaker ${t}` : t;
}

interface RunWaitResult { code: number; outcome: "completed" | "error" | "timeout" | "merge-missing" | "gone"; final: any; mergedId: string | null }

/** Poll the versions list every 10 s until run `tid` is no longer running. */
async function waitForVersionRun(ctx: Ctx, sc: VersionScope, tid: string, mode: string, capMin: number): Promise<RunWaitResult> {
  const deadline = Date.now() + capMin * 60_000;
  let final: any = null;
  let graceUntil = 0; // merge: the merged version may land a poll after the fill completes
  console.error(`Waiting for version ${tid} (up to ${capMin} min, poll 10s)…`);
  while (Date.now() < deadline) {
    await sleep(10_000);
    const r = await fetchVersions(ctx, sc);
    if (!r.ok) {
      if ([401, 403, 404].includes(r.status)) return { code: versionError(sc, "transcriptions", r.status, r.data), outcome: "gone", final, mergedId: null };
      continue; // 5xx / network hiccup: keep polling
    }
    final = r.data;
    const versions: any[] = final.versions ?? [];
    const v = versions.find((x) => x.id === tid);
    if (!v || v.status === "processing" || final.running?.transcriptionId === tid) continue;
    if (v.status === "error") return { code: 1, outcome: "error", final, mergedId: null };
    if (mode !== "merge") return { code: 0, outcome: "completed", final, mergedId: null };
    // The server orients base/fill by LANGUAGE (amendment A): the new run is the fill (it forced
    // the other language) or the base (an auto-en pass over a non-English active version).
    const merged = versions.find((x) => x.provider === "merge" && (x.merge?.fill === tid || x.merge?.base === tid));
    if (merged) return { code: 0, outcome: "completed", final, mergedId: merged.id };
    if (!graceUntil) graceUntil = Date.now() + 30_000;
    if (Date.now() >= graceUntil) return { code: 1, outcome: "merge-missing", final, mergedId: null };
  }
  return { code: 3, outcome: "timeout", final, mergedId: null };
}

/**
 * The five version verbs, on a meeting or a recording:
 * transcriptions | text --version | transcribe-again | merge-transcriptions | use-transcription.
 */
async function versionsCmd(ctx: Ctx, flags: Record<string, string | boolean>, kind: "meeting" | "recording", verb: string, args: string[]): Promise<number> {
  liftBoolFlags(args, flags, VERSION_BOOL_FLAGS);
  const tz = localTz(ctx);
  const prefix = kind === "meeting" ? "darth-cli meetings" : "darth-cli meetings recordings";
  const idWord = kind === "meeting" ? "<id>" : "<rid>";
  if (!args[0]) {
    const usage: Record<string, string> = {
      transcriptions: `transcriptions ${idWord} [--json]`,
      text: `text ${idWord} --version <tid>`,
      "transcribe-again": `transcribe-again ${idWord} [--language <code|auto>] [--model <m>] [--reason "…"] [--keep-active | --merge] [--merge-threshold 0.75] [--force] [--wait [--timeout <mins>]]`,
      "merge-transcriptions": `merge-transcriptions ${idWord} --base <tid> --fill <tid> [--threshold 0.75] [--reason "…"] [--dry-run] [--activate]`,
      "use-transcription": `use-transcription ${idWord} <tid>`,
    };
    console.error(`usage: ${prefix} ${usage[verb] ?? verb}`);
    return 1;
  }
  const sc = versionScope(kind, args[0]);

  switch (verb) {
    case "transcriptions": {
      const r = await fetchVersions(ctx, sc);
      if (!r.ok) return versionError(sc, "transcriptions", r.status, r.data);
      ctx.print(r.data, () => printVersionsView(sc, r.data, tz));
      return 0;
    }

    case "text": {
      const tid = str(flags.version)?.trim();
      if (!tid) { console.error(`usage: ${prefix} text ${idWord} --version <tid>   (<tid> = a version id from '${prefix} transcriptions ${idWord}')`); return 1; }
      const r = await recordingRequest(ctx, `${sc.base}/transcriptions/${encodeURIComponent(tid)}/content`, { method: "GET" });
      if (r.status === 202) { console.error(`version ${tid} is still transcribing — try again later ('${prefix} transcriptions ${sc.id}').`); return 1; }
      if (!r.ok) return versionError(sc, "text --version", r.status, r.data);
      const d = r.data ?? {};
      if (ctx.json) { console.log(JSON.stringify(d, null, 2)); return 0; }
      const utterances: any[] = d.utterances ?? [];
      const mergedCount = utterances.filter((u) => u.merged).length;
      // Header on stderr: stdout stays the same "[mm:ss] Speaker: …" shape as 'text'.
      console.error(`version ${d.transcriptionId ?? tid}${d.active ? " (active)" : " (not active)"} · ${d.provider ?? "?"} · language ${d.languageCode ?? "?"} · ${utterances.length} utterances${mergedCount ? ` · ${mergedCount} marked ⟨merged⟩ (words from the fill pass)` : ""}`);
      console.log(utterances.length
        ? utterances.map((u) => `[${fmtMs(u.start)}] ${speakerDisplay(u.speaker)}: ${u.text}${u.merged ? "  ⟨merged⟩" : ""}`).join("\n")
        : "(empty transcript)");
      return 0;
    }

    case "transcribe-again": {
      if (flags["keep-active"] === true && flags.merge === true) { console.error("pick one of --keep-active (keep it as a helper) and --merge (merge it into the active version)"); return 1; }
      const mode = flags.merge === true ? "merge" : flags["keep-active"] === true ? "helper" : "replace";
      const threshold = thresholdFlag(flags, "merge-threshold");
      if (threshold === null) return 1;
      if (threshold !== undefined && mode !== "merge") { console.error("--merge-threshold only applies with --merge"); return 1; }
      const body: Record<string, unknown> = {};
      if (flags.language !== undefined) {
        const lang = str(flags.language)?.trim().toLowerCase();
        if (!lang || !(lang === "auto" || lang === "auto-en" || /^[a-z]{2,3}([_-][a-z]{2,4})?$/.test(lang))) { console.error("--language must be a language code (id, zh, en_us, …), 'auto' or 'auto-en' (the English base pass of a mixed call)"); return 1; }
        body.languageCode = lang;
      }
      if (flags.model !== undefined) {
        const model = str(flags.model)?.trim();
        if (!model) { console.error("--model needs a value (e.g. universal-2)"); return 1; }
        body.speechModel = model;
      }
      const reason = str(flags.reason)?.trim();
      if (flags.reason !== undefined && !reason) { console.error('--reason needs a value ("wrong language", "English + Indonesian call")'); return 1; }
      if (reason) body.reason = reason;
      if (flags.force === true) body.force = true;
      if (mode !== "replace") body.mode = mode;
      if (threshold !== undefined) body.mergeOptions = { utteranceThreshold: threshold, wordThreshold: Math.max(0, Math.round((threshold - 0.1) * 100) / 100) }; // partial spans stay 0.10 stricter (server: 0.75 / 0.65)
      let capMin = 30;
      if (flags.timeout !== undefined) {
        if (flags.wait !== true) { console.error("--timeout only applies with --wait"); return 1; }
        capMin = Number(str(flags.timeout));
        if (!Number.isFinite(capMin) || capMin <= 0) { console.error(`--timeout must be a number of minutes (got '${str(flags.timeout) ?? ""}')`); return 1; }
      }
      ctx.requireWrite();
      if (mode === "replace" && typeof body.languageCode === "string" && body.languageCode !== "auto") {
        console.error(`note: --language ${body.languageCode} without --merge/--keep-active REPLACES the active version. Right for a call in ONE language that was detected wrong; on a MIXED call it is wrong: forced en DROPS the other language's speech, a forced other language TRANSLATES the English — use --merge there.`);
      }
      const r = await recordingRequest(ctx, `${sc.base}/${sc.runRoute}`, { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) return versionError(sc, "transcribe-again", r.status, r.data);
      const d = r.data ?? {};
      if (d.mode === "new-row" || d.already === true) {
        // Pre-Phase-2 path (meeting rows only): a whole new meeting row, no versions.
        ctx.print(d, () => {
          console.log(`${d.already ? "already re-transcribed the old way" : "transcribing again as a NEW meeting row (versions are not enabled here)"} → ${d.newId}`);
          console.log(`follow it with: darth-cli meetings get ${d.newId}`);
        });
        if (flags.wait === true) console.error("--wait is not supported on the legacy path — poll 'get' instead.");
        return 0;
      }
      const tid: string | undefined = d.transcriptionId ?? d.running?.transcriptionId;
      if (!tid) { console.error(`transcribe-again: the server accepted the run but named no version id — check '${sc.cmd} transcriptions ${sc.id}'.`); ctx.print(d, () => {}); return 1; }
      const run = d.running ?? {};
      const what = mode === "merge" ? "when it finishes it is MERGED into the active version and the merged version becomes active"
        : mode === "helper" ? "kept as a helper — the active version stays active"
        : "when it finishes it becomes the active version";
      if (flags.wait !== true) {
        ctx.print(d, () => {
          console.log(`transcribing again → version ${tid}  (${run.speechModel ?? body.speechModel ?? "default model"}, language ${run.languageCode ?? body.languageCode ?? "auto"}) — ${what}`);
          console.log(`follow it with: ${sc.cmd} transcriptions ${sc.id}   (or re-run with --wait)`);
        });
        return 0;
      }
      if (!ctx.json) console.error(`transcribing again → version ${tid}  (${run.speechModel ?? body.speechModel ?? "default model"}, language ${run.languageCode ?? body.languageCode ?? "auto"}) — ${what}`);
      const w = await waitForVersionRun(ctx, sc, tid, mode, capMin);
      if (w.outcome === "gone") return w.code;
      if (ctx.json) {
        console.log(JSON.stringify({ outcome: w.outcome, transcriptionId: tid, mode, mergedTranscriptionId: w.mergedId, run: d, transcriptions: w.final }, null, 2));
        return w.code;
      }
      if (w.final) printVersionsView(sc, w.final, tz);
      if (w.outcome === "timeout") {
        console.error(`Still running after ${capMin} min — it keeps going server-side; check later with '${sc.cmd} transcriptions ${sc.id}'.`);
      } else if (w.outcome === "error") {
        const v = (w.final?.versions ?? []).find((x: any) => x.id === tid);
        console.error(`version ${tid} failed: ${v?.error ?? "see the web app"} — the active version is unchanged.`);
      } else if (w.outcome === "merge-missing") {
        const active = (w.final?.versions ?? []).find((x: any) => x.active);
        const v = (w.final?.versions ?? []).find((x: any) => x.id === tid);
        const [b, f] = isEnglish(v?.languageCode) && !isEnglish(active?.languageCode) ? [tid, active?.id ?? "<active tid>"] : [active?.id ?? "<active tid>", tid];
        console.error(`version ${tid} completed, but no merged version was made — the server kept it as a helper (both versions English or both not, or the version active at the start is gone). Look at both, then merge by hand (base = the English one):`);
        console.error(`  ${sc.cmd} merge-transcriptions ${sc.id} --base ${b} --fill ${f} --dry-run`);
      } else if (mode === "merge") {
        // The version active before the run is the merge's other side (base or fill, by language).
        const m = (w.final?.versions ?? []).find((x: any) => x.id === w.mergedId)?.merge;
        const prev = m ? (m.base === tid ? m.fill : m.base) : "<previous tid>";
        console.log(`done: version ${tid} completed; merged version ${w.mergedId} is now active — spot-check '${sc.cmd} text ${sc.id}'; go back with '${sc.cmd} use-transcription ${sc.id} ${prev}' if it is worse.`);
      } else if (mode === "helper") {
        const active = (w.final?.versions ?? []).find((x: any) => x.active);
        const v = (w.final?.versions ?? []).find((x: any) => x.id === tid);
        const [b, f] = isEnglish(v?.languageCode) && !isEnglish(active?.languageCode) ? [tid, active?.id ?? "<active tid>"] : [active?.id ?? "<active tid>", tid];
        console.log(`done: version ${tid} completed and kept as a helper (not active). Read it: '${sc.cmd} text ${sc.id} --version ${tid}'; merge it (base = the English one): '${sc.cmd} merge-transcriptions ${sc.id} --base ${b} --fill ${f} --dry-run'.`);
      } else {
        console.log(`done: version ${tid} completed and is now active.`);
      }
      return w.code;
    }

    case "merge-transcriptions": {
      const base = str(flags.base)?.trim(), fill = str(flags.fill)?.trim();
      if (!base || !fill) { console.error(`usage: ${prefix} merge-transcriptions ${idWord} --base <tid> --fill <tid> [--threshold 0.75] [--reason "…"] [--dry-run] [--activate]   (tids from '${prefix} transcriptions ${idWord}')`); return 1; }
      if (base === fill) { console.error("--base and --fill must be two different versions"); return 1; }
      const threshold = thresholdFlag(flags, "threshold");
      if (threshold === null) return 1;
      const dryRun = flags["dry-run"] === true;
      if (dryRun && flags.activate === true) { console.error("--activate does nothing with --dry-run (nothing is written)"); return 1; }
      const body: Record<string, unknown> = { base, fill };
      if (threshold !== undefined) body.options = { utteranceThreshold: threshold, wordThreshold: Math.max(0, Math.round((threshold - 0.1) * 100) / 100) }; // partial spans stay 0.10 stricter (server: 0.75 / 0.65)
      const reason = str(flags.reason)?.trim();
      if (reason) body.reason = reason;
      if (dryRun) body.dryRun = true;
      if (flags.activate === true) body.activate = true;
      ctx.requireWrite();
      const r = await recordingRequest(ctx, `${sc.base}/transcriptions/merge`, { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) return versionError(sc, "merge-transcriptions", r.status, r.data);
      const d = r.data ?? {};
      ctx.print(d, () => {
        const s = d.stats ?? {};
        const warnings: string[] = Array.isArray(d.warnings) ? d.warnings.map(String) : [];
        for (const w of warnings) console.log(`WARNING: ${w}`);
        const touched = `${s.utterancesTouched ?? "?"} of ${s.utterances ?? "?"} utterances (${s.utterancesWhole ?? 0} whole), ${fmtMs(s.swappedMs)} of ${fmtMs(s.durationMs)} audio, ${s.fillWordsUsed ?? "?"} fill words`;
        if (d.dryRun) {
          console.log(`dry run — nothing written. Merging fill ${fill} into base ${base}${threshold !== undefined ? ` at threshold ${threshold}` : ""} would replace ${touched}.`);
          const preview: any[] = d.preview ?? [];
          for (const p of preview) {
            console.log(`[${fmtMs(p.start)}] ${speakerDisplay(p.speaker)}`);
            console.log(`    before: ${p.before}`);
            console.log(`    after:  ${p.after}`);
          }
          if (!preview.length) console.log("  (no utterance would change — the base is confident everywhere at this threshold)");
          console.log(`create it: ${sc.cmd} merge-transcriptions ${sc.id} --base ${base} --fill ${fill}${threshold !== undefined ? ` --threshold ${threshold}` : ""} --activate`);
          return;
        }
        console.log(`merged version ${d.transcriptionId} created — ${touched} replaced from ${fill}.`);
        console.log(d.activated
          ? `It is now ACTIVE (speaker names and edits of the base came with it). Spot-check: ${sc.cmd} text ${sc.id}`
          : `Not active. Read it: ${sc.cmd} text ${sc.id} --version ${d.transcriptionId}; switch to it: ${sc.cmd} use-transcription ${sc.id} ${d.transcriptionId}`);
      });
      return 0;
    }

    case "use-transcription": {
      const tid = args[1]?.trim();
      if (!tid) { console.error(`usage: ${prefix} use-transcription ${idWord} <tid>   (tid from '${prefix} transcriptions ${idWord}')`); return 1; }
      ctx.requireWrite();
      const r = await recordingRequest(ctx, `${sc.base}/transcriptions/${encodeURIComponent(tid)}/activate`, { method: "POST" });
      if (!r.ok) return versionError(sc, "use-transcription", r.status, r.data);
      const d = r.data ?? {};
      ctx.print(d, () => {
        console.log(`active version is now ${d.activeId ?? tid}`);
        const sa = d.setAside, re = d.restored;
        if (sa && (sa.edits || sa.speakerNames)) console.log(`set aside with the previous version: ${sa.edits ?? 0} edit(s), ${sa.speakerNames ?? 0} speaker name(s)`);
        if (re && (re.edits || re.speakerNames)) console.log(`restored with this version: ${re.edits ?? 0} edit(s), ${re.speakerNames ?? 0} speaker name(s)`);
        if (sc.kind === "meeting") console.log(`notes/report may have been written from another version — '${sc.cmd} transcriptions ${sc.id}' says; regenerate them in the web UI if so`);
      });
      return 0;
    }

    default:
      console.error(`Unknown transcription command: ${verb}`);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// share — who has access to a meeting; add / remove people. The same server
// handlers as the web Share dialog (GET/POST/PATCH/DELETE
// /api/transcripts/:id/shares): owner or editors manage shares, anyone with
// access may list them, a fresh share Slack-DMs the person exactly as a web
// share does. People come from the Trames directory (/api/users/search, the
// dialog's picker) — an address not in it is refused.
// ---------------------------------------------------------------------------

const SHARE_USAGE = "usage: darth-cli meetings share <id>[,<id>…] [<id> …] [--add <email>]… [--remove <email>]… [--access edit|read] [--json]";
const SHARE_EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** `source` of a share row (server lib/share-source.ts) → words. */
const SHARE_SOURCE_WORDS: Record<string, string> = {
  manual: "shared by hand",
  invite: "calendar invite (import)",
  "event-link": "calendar invite (linked event)",
  auditor: "auditor (outside party on the invite)",
  "series-follow": "series follower",
  "previous-owner": "previous owner",
};

type ShareEntry = { email: string; name: string | null; access: string; source: string | null; shared_at: string | null; shared_by: string | null };
type ShareChange = { op: "add" | "remove"; email: string; result: "added" | "updated" | "removed" | "already" | "refused"; access?: string; error?: string };
type ShareView = { id: string; title: string | null; url: string; your_access: string | null; owner: { email: string | null; name: string | null }; shared_with: ShareEntry[]; changes?: ShareChange[] };

/** The share rows of GET /api/transcripts/:id/shares, flattened for print + --json. */
function shareEntries(data: any): ShareEntry[] {
  return (data?.shares ?? []).map((s: any) => ({
    email: String(s.shared_with_email ?? ""),
    name: s.shared_with_name ?? null,
    access: String(s.access ?? "?"),
    source: s.source ?? null,
    shared_at: s.shared_at ?? null,
    shared_by: s.shared_by?.email ?? null,
  }));
}

function shareView(ctx: Ctx, id: string, title: string | null, data: any): ShareView {
  return {
    id,
    title,
    url: `${webBase(ctx)}/transcript/${id}`,
    your_access: data?.access ?? (data?.owner?.isMe ? "owner" : null),
    owner: { email: data?.owner?.email ?? null, name: data?.owner?.name ?? null },
    shared_with: shareEntries(data),
  };
}

/** One-line summary for 'get': "ivan@trames.sg (edit), bea@trames.sg (read, auditor)". */
function sharedWithLine(rows: ShareEntry[]): string {
  if (!rows.length) return "nobody else";
  return rows.map(r => `${r.email} (${r.access}${r.source && r.source !== "manual" ? `, ${SHARE_SOURCE_WORDS[r.source] ?? r.source}` : ""})`).join(", ");
}

function printShareView(ctx: Ctx, v: ShareView): void {
  const tz = localTz(ctx);
  const me = (ctx.config.email ?? "").toLowerCase();
  console.log(`${v.id}${v.title ? `  "${v.title}"` : ""}`);
  console.log(`  owner  ${v.owner.email ?? "?"}${v.owner.name ? ` (${v.owner.name})` : ""}${v.your_access === "owner" ? "  ← you" : ""}`);
  if (!v.shared_with.length) console.log("  shared with nobody else");
  for (const s of v.shared_with) {
    const why = s.source ? SHARE_SOURCE_WORDS[s.source] ?? s.source : "";
    const when = s.shared_at ? `added ${fmtLocalDateTime(s.shared_at, tz)}` : "";
    const by = s.shared_by ? `by ${s.shared_by}` : "";
    const tail = [why, [when, by].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
    console.log(`  ${s.access.padEnd(5)}  ${s.email}${s.name ? ` (${s.name})` : ""}${s.email.toLowerCase() === me ? "  ← you" : ""}${tail ? `  — ${tail}` : ""}`);
  }
  if (v.your_access && v.your_access !== "owner" && v.your_access !== "edit") console.log(`  (you have ${v.your_access} access: only the owner or an editor can change who it is shared with)`);
}

/** A failed share request → stderr; 401 → 3, everything else → 1. */
function shareRequestError(id: string, status: number, data: any): number {
  const msg = data?.error ?? `HTTP ${status}`;
  if (status === 401) console.error(`Unauthorized: ${msg}\nYour token may be expired/revoked — run: darth-cli login`);
  else if (status === 404) console.error(`No meeting ${id} visible to you (${msg}).${id.startsWith("rec-") ? " That is a recording id — recordings are never shared; share the MEETING it is in ('recordings get' names it)." : ""}`);
  else if (status === 403) console.error(`${id}: ${msg}${/token is read-only/.test(msg) ? "" : " — ask its owner"}`);
  else console.error(`${id}: ${msg} (HTTP ${status})`);
  return status === 401 ? 3 : 1;
}

/** An email → the directory person the web Share dialog would pick, or a refusal. */
async function resolveSharePerson(ctx: Ctx, email: string): Promise<{ ok: true; name: string | null; pplId: number | null } | { ok: false; code: number }> {
  const r = await recordingRequest(ctx, `/api/users/search?${new URLSearchParams({ q: email, limit: "10" })}`, { method: "GET" });
  if (!r.ok) {
    console.error(`Looking up ${email} in the people directory failed (HTTP ${r.status}): ${r.data?.error ?? ""}`.trim());
    return { ok: false, code: r.status === 401 ? 3 : 1 };
  }
  const people: any[] = Array.isArray(r.data?.people) ? r.data.people : [];
  const hit = people.find(p => typeof p?.email === "string" && p.email.trim().toLowerCase() === email);
  if (hit) return { ok: true, name: hit.name ?? null, pplId: hit.source === "trames" && typeof hit.id === "number" ? hit.id : null };
  const near = people.filter(p => typeof p?.email === "string").slice(0, 5).map(p => `${p.email}${p.name ? ` (${p.name})` : ""}`);
  console.error(`${email} is not in the Trames people directory (the people the web Share dialog offers) — nothing was shared.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`);
  return { ok: false, code: 1 };
}

async function shareCmd(ctx: Ctx, flags: Record<string, string | boolean>, argv: string[], args: string[]): Promise<number> {
  const ids = [...new Set(args.flatMap(a => a.split(",")).map(s => s.trim()).filter(Boolean))];
  if (!ids.length) { console.error(SHARE_USAGE); return 1; }
  if (flags.add === true || flags.remove === true) { console.error(`--add / --remove need an email\n${SHARE_USAGE}`); return 1; }
  const adds = [...new Set(allFlagValues(argv, "add").map(e => e.toLowerCase()))];
  const removes = [...new Set(allFlagValues(argv, "remove").map(e => e.toLowerCase()))];
  const access = flags.access === undefined ? undefined : str(flags.access);
  if (flags.access !== undefined && access !== "edit" && access !== "read") { console.error(`--access must be edit or read\n${SHARE_USAGE}`); return 1; }
  if (access && !adds.length) { console.error(`--access goes with --add (it sets the level of the people you add, or changes theirs if they already have a share)\n${SHARE_USAGE}`); return 1; }
  const bad = [...adds, ...removes].filter(e => !SHARE_EMAIL_RE.test(e));
  if (bad.length) { console.error(`not an email address: ${bad.join(", ")}\n${SHARE_USAGE}`); return 1; }
  const both = adds.filter(e => removes.includes(e));
  if (both.length) { console.error(`both --add and --remove for ${both.join(", ")} — pick one`); return 1; }
  const changing = adds.length + removes.length > 0;
  if (changing) ctx.requireWrite();

  // Every address is checked against the directory BEFORE any meeting is
  // touched, so a typo changes nothing anywhere.
  const people = new Map<string, { name: string | null; pplId: number | null }>();
  for (const e of adds) {
    const p = await resolveSharePerson(ctx, e);
    if (!p.ok) return p.code;
    people.set(e, p);
  }

  const views: ShareView[] = [];
  let exit = 0;
  const fail = (code: number) => { if (code === 3 || exit === 0) exit = code; };
  const sharesPath = (id: string) => `/api/transcripts/${id}/shares`;

  for (const id of ids) {
    const [before, meta] = await Promise.all([
      recordingRequest(ctx, sharesPath(id), { method: "GET" }),
      recordingRequest(ctx, `/api/transcripts/${id}`, { method: "GET" }).catch(() => null),
    ]);
    if (!before.ok) { fail(shareRequestError(id, before.status, before.data)); continue; }
    const t = meta?.ok ? meta.data?.transcript : null;
    const title: string | null = t ? (t.title || t.original_filename || null) : null;
    if (!changing) { views.push(shareView(ctx, id, title, before.data)); continue; }

    const owner = String(before.data?.owner?.email ?? "").toLowerCase();
    const current = new Map<string, ShareEntry>(shareEntries(before.data).map(s => [s.email.toLowerCase(), s]));
    const changes: ShareChange[] = [];
    const refuse = (c: ShareChange, status?: number) => {
      changes.push(c);
      console.error(`${id}: ${c.op} ${c.email} refused — ${c.error}`);
      fail(status === 401 ? 3 : 1);
    };
    const write = async (method: string, body: Record<string, unknown>) => recordingRequest(ctx, sharesPath(id), { method, body: JSON.stringify(body) });

    for (const e of removes) {
      if (owner && e === owner) { refuse({ op: "remove", email: e, result: "refused", error: "that is the owner; a meeting always has its owner (ownership is handed over with 'Make owner…' in the web Share dialog)" }); continue; }
      if (!current.has(e)) { refuse({ op: "remove", email: e, result: "refused", error: "the meeting is not shared with them, nothing to remove" }); continue; }
      const r = await write("DELETE", { email: e });
      if (r.ok) changes.push({ op: "remove", email: e, result: "removed" });
      else refuse({ op: "remove", email: e, result: "refused", error: r.data?.error ?? `HTTP ${r.status}` }, r.status);
    }
    for (const e of adds) {
      if (owner && e === owner) { changes.push({ op: "add", email: e, result: "already", access: "owner" }); continue; }
      const cur = current.get(e);
      if (cur) {
        if (!access || cur.access === access) { changes.push({ op: "add", email: e, result: "already", access: cur.access }); continue; }
        const r = await write("PATCH", { email: e, access });
        if (r.ok) changes.push({ op: "add", email: e, result: "updated", access });
        else refuse({ op: "add", email: e, result: "refused", error: r.data?.error ?? `HTTP ${r.status}` }, r.status);
        continue;
      }
      const p = people.get(e)!;
      const level = access ?? "edit";
      const r = await write("POST", { email: e, ...(p.name ? { name: p.name } : {}), ...(p.pplId !== null ? { pplId: p.pplId } : {}), access: level });
      if (r.ok) changes.push({ op: "add", email: e, result: "added", access: level });
      else refuse({ op: "add", email: e, result: "refused", error: r.data?.error ?? `HTTP ${r.status}` }, r.status);
    }

    const wrote = changes.some(c => c.result === "added" || c.result === "updated" || c.result === "removed");
    const after = wrote ? await recordingRequest(ctx, sharesPath(id), { method: "GET" }) : before;
    views.push({ ...shareView(ctx, id, title, after.ok ? after.data : before.data), changes });
  }

  if (!views.length) return exit || 1;
  ctx.print(views.length === 1 && ids.length === 1 ? views[0] : views, () => {
    views.forEach((v, i) => {
      if (i) console.log("");
      for (const c of v.changes ?? []) {
        if (c.result === "added") console.log(`+ shared with ${c.email} (${c.access}) — they get a Slack DM, as from the web Share dialog`);
        else if (c.result === "updated") console.log(`~ ${c.email} now has ${c.access} access`);
        else if (c.result === "removed") console.log(`- removed ${c.email}`);
        else if (c.result === "already") console.log(c.access === "owner" ? `= ${c.email} is the owner` : `= ${c.email} already has ${c.access} access${access ? "" : " (--access edit|read changes the level)"}`);
      }
      printShareView(ctx, v);
    });
  });
  return exit;
}

async function recordingsCmd(ctx: Ctx, flags: Record<string, string | boolean>, pos: string[]): Promise<number> {
  liftBoolFlags(pos, flags, ["all", "envelope", "unlinked", "temporary", "regex", "separate"]);
  const [sub, ...args] = pos;
  if (!sub || sub === "help" || flags.help === true) { console.log(RECORDINGS_HELP); return 0; }
  const tz = localTz(ctx);
  const needRid = (usage: string): string | null => {
    if (!args[0]) { console.error(`usage: darth-cli meetings recordings ${usage}`); return null; }
    return recId(args[0]);
  };

  switch (sub) {
    case "list":
    case "ls": {
      const section = str(flags.section);
      const picks = [section ? "--section" : null, flags.unlinked === true ? "--unlinked" : null, flags.temporary === true ? "--temporary" : null].filter(Boolean);
      if (picks.length > 1) { console.error(`pick one of ${picks.join(", ")}`); return 1; }
      if (flags.section !== undefined && !["mac", "uploaded", "temporary", "linked"].includes(section ?? "")) { console.error("--section must be mac, uploaded, temporary or linked"); return 1; }
      const q = new URLSearchParams({ mine: "1", tz });
      if (section) q.set("section", section);
      else if (flags.unlinked === true) q.set("unlinked", "1");
      else if (flags.temporary === true) q.set("section", "temporary");
      const text = str(flags.q);
      if (flags.q !== undefined && !text?.trim()) { console.error("--q needs a value"); return 1; }
      if (text) q.set("q", text.trim());
      if (flags.regex === true) {
        if (!text) { console.error("--regex needs --q <pattern>"); return 1; }
        q.set("regex", "1");
      }
      let limit: number | null = null;
      if (flags.limit !== undefined) {
        const raw = str(flags.limit) ?? "";
        if (!/^\d+$/.test(raw) || Number(raw) > 200) { console.error("--limit must be a whole number 0..200"); return 1; }
        limit = Number(raw);
      }
      const drainAll = flags.all === true;
      if (drainAll && limit === 0) { console.error("--all with --limit 0 would never advance"); return 1; }
      q.set("limit", String(limit ?? (drainAll ? 200 : 50)));
      let cursor = str(flags.cursor) ?? null;
      if (flags.cursor !== undefined && !cursor) { console.error("--cursor needs a value"); return 1; }
      const items: any[] = [];
      let counts: any = null;
      let next: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 1000; page++) {
        const pq = new URLSearchParams(q);
        if (cursor) pq.set("cursor", cursor);
        const data = await ctx.expectJson<{ items: any[]; next_cursor: string | null; counts: any }>(ctx.api("meetings", `/api/recordings?${pq}`));
        if (counts === null) counts = data.counts;
        items.push(...(data.items ?? []));
        next = data.next_cursor ?? null;
        if (!drainAll || !next || seen.has(next)) break;
        seen.add(next);
        cursor = next;
      }
      if (drainAll && next && seen.has(next)) next = null; // server repeated a cursor — stop, don't loop
      const envelope = flags.envelope === true;
      if (envelope) { console.log(JSON.stringify({ items, next_cursor: next, counts, truncated: next !== null }, null, 2)); return 0; }
      ctx.print(items, () => {
        const c = counts ?? {};
        console.log(`${c.mac ?? 0} on your Macs · ${c.uploaded ?? 0} uploaded · ${c.temporary ?? 0} temporary${typeof c.linked === "number" ? ` · ${c.linked} linked to a meeting` : ""}`);
        if (!items.length) console.log("No recordings here — private recordings appear once you upload without --event (or the Darth Recorder saves one).");
        for (const it of items) console.log(recordingItemLine(it, tz).line);
        if (next) console.log(`more: --cursor ${next}`);
      });
      return 0;
    }

    case "get": {
      const rid = needRid("get <rid>");
      if (!rid) return 1;
      const data = await ctx.expectJson<{ recording: any }>(ctx.api("meetings", `/api/recordings/${rid}`));
      ctx.print(data.recording, () => printRecordingView(data.recording, tz));
      return 0;
    }

    case "text": {
      if (flags.version !== undefined) return versionsCmd(ctx, flags, "recording", "text", args);
      const rid = needRid("text <rid>");
      if (!rid) return 1;
      const res = await ctx.api("meetings", `/api/recordings/${rid}/content`);
      if (res.status === 202) { console.error(`${rid} is still transcribing — try again later ('recordings get ${rid}' shows the status).`); return 1; }
      const data = await ctx.expectJson<any>(res);
      const content = data.content ?? data;
      if (ctx.json) { console.log(JSON.stringify(content, null, 2)); return 0; }
      const utterances: any[] = content.utterances || [];
      console.log(utterances.length
        ? utterances.map((u) => `[${fmtMs(u.start)}] Speaker ${u.speaker}: ${u.text}`).join("\n")
        : content.text || "(empty transcript)");
      return 0;
    }

    case "transcriptions":
    case "transcribe-again":
    case "merge-transcriptions":
    case "use-transcription":
      return versionsCmd(ctx, flags, "recording", sub, args);

    case "audio": {
      const rid = needRid("audio <rid> [--out <file>]");
      if (!rid) return 1;
      return downloadStreamed(ctx, `/api/recordings/${rid}/audio`, str(flags.out), `rec-${rid}`);
    }

    case "link": {
      const rid = args[0] ? recId(args[0]) : null;
      const ref = args[1];
      if (!rid || !ref) { console.error("usage: darth-cli meetings recordings link <rid> <meeting-code|event-key|meeting-id> [--title T] [--offset-ms N] [--separate]"); return 1; }
      ctx.requireWrite();
      const body: Record<string, unknown> = {};
      if (flags.separate === true && !isEventRef(ref)) { console.error("--separate only applies when linking to a calendar event"); return 1; }
      if (isEventRef(ref)) {
        body.eventRef = ref;
        if (flags.separate === true) body.mode = "separate";
        const title = str(flags.title);
        if (title) body.title = title;
        if (flags["offset-ms"] !== undefined) { console.error("--offset-ms only applies when linking to an existing meeting id"); return 1; }
      } else {
        body.meetingId = ref;
        if (flags.title !== undefined) { console.error("--title only applies when linking to a calendar event (the meeting keeps its own title)"); return 1; }
        if (flags["offset-ms"] !== undefined) {
          const raw = str(flags["offset-ms"]) ?? "";
          if (!/^-?\d+$/.test(raw)) { console.error("--offset-ms must be a whole number of milliseconds"); return 1; }
          body.offsetMs = Number(raw);
        }
      }
      const r = await recordingRequest(ctx, `/api/recordings/${rid}/link`, { method: "POST", body: JSON.stringify(body) });
      if (!r.ok) {
        const code = recordingWriteError("link", r.status, r.data);
        if (r.status === 404 && isEventRef(ref)) console.error("Tip: 'darth-cli meetings calendar --view all --json' lists your events with their [meeting-code] and exact 'key'; a meeting code resolves to its latest PAST occurrence — use the key for an older one.");
        return code;
      }
      const mid = r.data?.meeting?.id ?? r.data?.meetingId ?? (isEventRef(ref) ? "?" : ref);
      ctx.print(r.data, () => {
        if (r.data?.joined === true) {
          console.log(`joined → meeting ${mid}${r.data?.meeting?.title ? ` "${r.data.meeting.title}"` : ""} — that occurrence already had a meeting you can open, so your recording was added to it (no new share; --separate makes a meeting of its own)`);
          if (r.data?.text === "pending") console.log("Its text is merged into the meeting when the transcription finishes.");
          else if (r.data?.text === "waiting-combine") console.log("Reserved for that meeting — it is added once the server enables combined meetings.");
          if (mid !== "?") console.log(`Web: ${webBase(ctx)}/transcript/${mid}`);
          return;
        }
        console.log(`linked → meeting ${mid}${r.data?.meeting?.title ? ` "${r.data.meeting.title}"` : ""} — ${isEventRef(ref) ? `shared with ${r.data?.shares ?? 0} Trames invitee(s) of the event` : "added (the meeting's own shares apply)"}`);
        if (mid !== "?") console.log(`Web: ${webBase(ctx)}/transcript/${mid}`);
      });
      return 0;
    }

    case "make-meeting": {
      const rid = args[0] ? recId(args[0]) : null;
      const title = str(flags.title)?.trim();
      if (!rid || !title) { console.error('usage: darth-cli meetings recordings make-meeting <rid> --title "…"   (title required)'); return 1; }
      ctx.requireWrite();
      const r = await recordingRequest(ctx, `/api/recordings/${rid}/make-meeting`, { method: "POST", body: JSON.stringify({ title }) });
      if (!r.ok) return recordingWriteError("make-meeting", r.status, r.data);
      const m = r.data?.meeting ?? {};
      ctx.print(r.data, () => {
        console.log(`meeting ${m.id ?? "?"} "${m.title ?? title}" made from recording ${rid} — not shared ('darth-cli meetings share ${m.id ?? "<id>"} --add <email>' when the human wants it shared)`);
        if (m.id) console.log(`Web: ${webBase(ctx)}/transcript/${m.id}`);
      });
      return 0;
    }

    case "keep": {
      const rid = needRid("keep <rid>");
      if (!rid) return 1;
      ctx.requireWrite();
      const r = await recordingRequest(ctx, `/api/recordings/${rid}`, { method: "PATCH", body: JSON.stringify({ keep: true }) });
      if (!r.ok) return recordingWriteError("keep", r.status, r.data);
      ctx.print(r.data, () => console.log(`kept ${rid} — no expiry any more; it stays a private recording`));
      return 0;
    }

    case "dismiss": {
      const rid = needRid("dismiss <rid>");
      if (!rid) return 1;
      ctx.requireWrite();
      const r = await recordingRequest(ctx, `/api/recordings/${rid}`, { method: "PATCH", body: JSON.stringify({ dismissSuggestedEvent: true }) });
      if (!r.ok) return recordingWriteError("dismiss", r.status, r.data);
      const next = r.data?.recording?.suggested_event;
      ctx.print(r.data, () => {
        console.log(`dismissed the suggested event on ${rid} — it is no longer offered ('recordings link ${rid} <ref>' still links any event by hand)`);
        if (next) console.log(`next suggestion: ${next.title || "(untitled)"} · ${fmtLocalDateTime(String(next.startIso), tz)}`);
      });
      return 0;
    }

    case "rm": {
      const rid = needRid("rm <rid>");
      if (!rid) return 1;
      ctx.requireWrite();
      const r = await recordingRequest(ctx, `/api/recordings/${rid}`, { method: "DELETE" });
      if (!r.ok) return recordingWriteError("rm", r.status, r.data);
      ctx.print(r.data, () => console.log(r.data?.deleted === false ? `${rid}: nothing deleted` : `deleted recording ${rid}`));
      return 0;
    }

    default:
      console.error(`Unknown recordings command: ${sub}\n`);
      console.log(RECORDINGS_HELP);
      return 1;
  }
}

// ---------------------------------------------------------------------------
// CLI ↔ UI parity, batch B (task 05) — the remaining list-page / settings
// actions: a label's color, the calendar rows' Hide / Unhide / "check at
// Google / Microsoft", the home reminders card, a series' occurrences, and
// the vocabulary editor (a settings-class write behind --consent).
// ---------------------------------------------------------------------------

/** Non-2xx on a batch-B call → one readable line; returns the exit code (3 on a 401). */
function apiError(verb: string, status: number, data: JsonRec | null): number {
  const msg = typeof data?.error === "string" ? data.error : `HTTP ${status}`;
  if (status === 401) console.error(`Unauthorized: ${msg}\nYour token may be expired/revoked — run: darth-cli login`);
  else if (status === 403 || status === 409) console.error(`${verb} refused: ${msg}`);
  else if (status === 404) console.error(`${verb} failed: not found (${msg}).`);
  else console.error(`${verb} failed (HTTP ${status}): ${msg}`);
  return status === 401 ? 3 : 1;
}

/** `<label> <color>`: '#rrggbb' / 'rrggbb' (shells eat an unquoted '#…' as a
 * comment) → '#rrggbb'; 'none' → null = the rail's "No color (inherit
 * parent)"; anything else → undefined (usage error). */
function parseLabelColor(raw: string): string | null | undefined {
  const v = raw.trim();
  if (/^none$/i.test(v)) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v);
  return m ? `#${m[1]!.toLowerCase()}` : undefined;
}

const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const TEAMS_CODE_RE = /^teams-[0-9a-f]{12}$/;

/** '<eventId|meeting-code>|<start>' → its parts; null when it is not one. */
function parseEventKey(raw: string): { head: string; startMs: number } | null {
  const k = raw.trim();
  const bar = k.lastIndexOf("|");
  if (bar <= 0 || bar === k.length - 1) return null;
  const startMs = Date.parse(k.slice(bar + 1));
  return Number.isNaN(startMs) ? null : { head: k.slice(0, bar), startMs };
}

/** The `GET /api/calendar/events` row fields the batch-B verbs read. */
interface CalRow {
  key: string;
  eventId: string | null;
  recurringEventId: string | null;
  title: string | null;
  start: string;
  end: string | null;
  meetingCode: string | null;
  provider: "gmeet" | "teams" | null;
  organizerEmail: string | null;
}

function dayShift(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const EVENT_KEY_HINT = "'darth-cli meetings calendar --view all --details' prints each row's key: line (--json: \"key\")";

/** The calendar row behind an event key: `GET /api/calendar/events` (cache
 * only, the key's local day ±1, hidden rows included). The exact key wins;
 * else the same instant with the key's head as event id or meeting code
 * (unimported-layer rows are keyed '<meeting-code>|<start>'). */
async function findCalendarRow(ctx: Ctx, verb: string, key: string): Promise<{ row: CalRow | null } | { code: number }> {
  const k = parseEventKey(key);
  if (!k) return { row: null };
  const tz = localTz(ctx);
  const day = fmtLocalDateTime(new Date(k.startMs).toISOString(), tz).slice(0, 10);
  const q = new URLSearchParams({ from: dayShift(day, -1), to: dayShift(day, 1), tz, sync: "0" });
  const r = await meetingsCall(ctx, `/api/calendar/events?${q}`, "GET");
  if (!r.ok) return { code: apiError(verb, r.status, r.data) };
  const events = (Array.isArray(r.data?.events) ? r.data.events : []) as CalRow[];
  const want = key.trim();
  const row = events.find((e) => e.key === want)
    ?? events.find((e) => Date.parse(e.start) === k.startMs && (e.eventId === k.head || e.meetingCode === k.head))
    ?? null;
  return { row };
}

/** The calendar row's "At Google / Microsoft — check" request, exactly the
 * body calendar-meeting-rows.tsx sends. */
function evidenceRequest(row: CalRow, teams: boolean): { path: string; body: JsonRec } | { error: string } {
  const name = `"${row.title || "(untitled)"}"`;
  if (teams) {
    if (!row.meetingCode && !row.eventId) return { error: `${name} has no Teams meeting code or calendar event id — nothing to check at Microsoft` };
    return {
      path: "/api/teams/evidence",
      body: {
        meetingCode: row.meetingCode,
        eventId: row.eventId,
        startTime: row.start,
        endTime: row.end,
        event: { recurringEventId: row.recurringEventId, organizerEmail: row.organizerEmail },
      },
    };
  }
  if (!row.meetingCode || !MEET_CODE_RE.test(row.meetingCode)) {
    return { error: `${name} has no Google Meet link — nothing to check at Google${row.eventId ? " (a Teams call? add --teams)" : ""}` };
  }
  return {
    path: "/api/meet/evidence",
    body: { meetingCode: row.meetingCode, startTime: row.start, event: { id: row.eventId, recurringEventId: row.recurringEventId } },
  };
}

interface ChatVerdictLike {
  held?: boolean; recorded?: boolean; transcribed?: boolean;
  callStart?: string | null; callEnd?: string | null; durationMs?: number | null; reason?: string | null;
}
interface EvidenceReply {
  checkFailed?: boolean;
  error?: string;
  recording?: { state?: string; listed?: number; ready?: number };
  transcript?: { state?: string; listed?: number; source?: string | null };
  verdict?: { hasRecording?: boolean; hasTranscript?: boolean; pending?: boolean; importable?: boolean };
  external?: boolean;
  tenantId?: string;
  resolved?: boolean;
  imported?: { assemblyaiId: string | null; title: string | null; ownerEmail: string | null; accessible: boolean } | null;
  chat?: ChatVerdictLike | null;
}

/** The Teams chat verdict (was the call held / recorded) in words. */
function chatLine(c: ChatVerdictLike | null | undefined, tz: string): string | null {
  if (!c) return null;
  if (c.reason) return `chat:       not readable (${c.reason})`;
  if (!c.held) return "chat:       no call was held in the meeting chat";
  const span = c.callStart ? ` ${fmtLocalDateTime(c.callStart, tz)}${c.callEnd ? `–${fmtLocalDateTime(c.callEnd, tz).slice(11)}` : ""}` : "";
  const mins = typeof c.durationMs === "number" ? ` (${fmtMins(c.durationMs / 1000)})` : "";
  return `chat:       call held${span}${mins}${c.recorded ? ", recorded" : ", not recorded"}${c.transcribed ? ", transcribed" : ""}`;
}

/** An evidence answer in the handler's words → lines + exit code (1 = the
 * provider did not answer, nothing concluded). */
function evidenceLines(teams: boolean, d: EvidenceReply, importRef: string, tz: string): { lines: string[]; code: number } {
  const lines: string[] = [];
  const importHint = `import it: darth-cli meetings import '${importRef}'`;
  if (teams) {
    const chat = chatLine(d.chat, tz);
    if (d.external) {
      lines.push(`organized outside our tenant${d.tenantId ? ` (${d.tenantId})` : ""} — app-only access can't see its recording/transcript; import it from the web import dialog's manual panel`);
      if (chat) lines.push(chat);
      return { lines, code: 0 };
    }
    if (d.checkFailed) {
      lines.push(`Microsoft didn't answer — ${d.error ?? "try again"} (nothing concluded)`);
      if (chat) lines.push(chat);
      return { lines, code: 1 };
    }
    if (d.resolved === false) lines.push("Microsoft has no record of this meeting");
    else {
      lines.push(`recording:  ${d.verdict?.hasRecording ? "yes" : "no"}`);
      lines.push(`transcript: ${d.verdict?.hasTranscript ? "yes" : "no"}`);
    }
    if (chat) lines.push(chat);
    const imp = d.imported;
    if (imp) {
      lines.push(imp.accessible && imp.assemblyaiId
        ? `already imported → ${imp.assemblyaiId}${imp.title ? ` "${imp.title}"` : ""}`
        : `already imported by ${imp.ownerEmail ?? "someone else"} (you can't open it — ask them to share it)`);
    } else if (d.verdict?.importable) lines.push(`importable now — ${importHint}`);
    else lines.push("nothing at Microsoft to import");
    return { lines, code: 0 };
  }
  if (d.checkFailed) return { lines: ["Google didn't answer — try again (nothing concluded)"], code: 1 };
  const rec = d.recording ?? {};
  const tr = d.transcript ?? {};
  lines.push(`recording:  ${rec.state ?? "?"}${rec.listed ? ` (${rec.ready ?? 0} of ${rec.listed} file(s) ready)` : ""}`);
  lines.push(`transcript: ${tr.state ?? "?"}${tr.source && tr.state !== "none" ? ` (${tr.source})` : ""}`);
  const v = d.verdict ?? {};
  if (v.importable && v.pending) lines.push(`listed at Google, still being generated — importable once it lands ('import' queues it): ${importHint}`);
  else if (v.importable) lines.push(`importable now — ${importHint}`);
  else lines.push("nothing at Google — never recorded");
  return { lines, code: 0 };
}

interface MuteEntry { kind: string; value: string; title: string | null; createdAt: string }

async function fetchMutes(ctx: Ctx, verb: string): Promise<{ mutes: MuteEntry[]; data: JsonRec | null } | { code: number }> {
  const r = await meetingsCall(ctx, "/api/calendar-mutes", "GET");
  if (!r.ok) return { code: apiError(verb, r.status, r.data) };
  return { mutes: (Array.isArray(r.data?.mutes) ? r.data.mutes : []) as MuteEntry[], data: r.data };
}

const CALENDAR_SUBS = ["hidden", "hide", "unhide", "check"];

/** calendar hidden | hide <key> [--series] [--title t] | unhide <key|value> [--series] | check <key> [--teams] */
async function calendarSubCmd(ctx: Ctx, flags: Record<string, string | boolean>, sub: string, args: string[]): Promise<number> {
  // Local lifts: --series / --teams take values elsewhere (series preview --series <id>, auto-sync --teams on).
  liftBoolFlags(args, flags, ["series", "teams"]);
  const tz = localTz(ctx);
  const key = args[0]?.trim() ?? "";
  const series = flags.series === true;

  if (sub === "hidden") {
    if (args.length) { console.error("usage: darth-cli meetings calendar hidden"); return 1; }
    const got = await fetchMutes(ctx, "calendar hidden");
    if ("code" in got) return got.code;
    ctx.print(got.data, () => {
      if (!got.mutes.length) { console.log("Nothing hidden — 'calendar hide <event-key>' hides a row."); return; }
      for (const m of got.mutes) {
        console.log(`${m.kind.padEnd(10)}  ${fmtLocalDateTime(m.createdAt, tz)}  ${m.title || "(untitled)"}  ${m.value}`);
      }
      console.log(`\n${got.mutes.length} hidden (hidden at, tz ${tz}) — unhide: darth-cli meetings calendar unhide '<value>' (add --series for a series row)`);
    });
    return 0;
  }

  if (sub === "hide") {
    if (!key || args.length > 1) { console.error('usage: darth-cli meetings calendar hide <event-key> [--series] [--title "<t>"]'); return 1; }
    if (!parseEventKey(key)) { console.error(`'${key}' is not an event key ('<eventId>|<start>') — ${EVENT_KEY_HINT}`); return 1; }
    if (flags.title === true) { console.error("--title needs a value"); return 1; }
    ctx.requireWrite();
    const found = await findCalendarRow(ctx, "calendar hide", key);
    if ("code" in found) return found.code;
    const row = found.row;
    if (!row) { console.error(`No calendar event with key '${key}' in your calendar cache — ${EVENT_KEY_HINT}`); return 1; }
    if (series && !row.recurringEventId) { console.error(`"${row.title || "(untitled)"}" is not a recurring event — drop --series to hide just this occurrence`); return 1; }
    const kind = series ? "series" : "occurrence";
    const value = series ? row.recurringEventId! : key;
    const title = str(flags.title)?.trim() || row.title || undefined;
    const r = await meetingsCall(ctx, "/api/calendar-mutes", "POST", { kind, value, ...(title ? { title } : {}) });
    if (!r.ok) return apiError("calendar hide", r.status, r.data);
    ctx.print({ ...(r.data ?? {}), kind, value, title: title ?? null }, () => {
      console.log(series
        ? `hidden: "${title || "(untitled)"}" — every occurrence of the series, future ones too`
        : `hidden: "${title || "(untitled)"}" ${fmtLocalDateTime(row.start, tz)} (this occurrence)`);
      console.log(`undo: darth-cli meetings calendar unhide '${value}'${series ? " --series" : ""}`);
    });
    return 0;
  }

  if (sub === "unhide") {
    if (!key || args.length > 1) { console.error("usage: darth-cli meetings calendar unhide <event-key | value from 'calendar hidden'> [--series]"); return 1; }
    ctx.requireWrite();
    let value = key;
    if (series && parseEventKey(key)) {
      const found = await findCalendarRow(ctx, "calendar unhide", key);
      if ("code" in found) return found.code;
      if (!found.row) { console.error(`No calendar event with key '${key}' in your calendar cache — pass the series value 'calendar hidden' prints instead`); return 1; }
      if (!found.row.recurringEventId) { console.error(`"${found.row.title || "(untitled)"}" is not a recurring event — drop --series`); return 1; }
      value = found.row.recurringEventId;
    }
    const kind = series ? "series" : "occurrence";
    const got = await fetchMutes(ctx, "calendar unhide");
    if ("code" in got) return got.code;
    const hit = got.mutes.find((m) => m.kind === kind && m.value === value);
    if (!hit) {
      const other = got.mutes.find((m) => m.value === value);
      console.error(`Nothing is hidden as ${kind} '${value}'${other ? ` — it is hidden as ${other.kind}: ${other.kind === "series" ? "add" : "drop"} --series` : ""} ('calendar hidden' lists what is hidden).`);
      return 1;
    }
    const r = await meetingsCall(ctx, `/api/calendar-mutes?${new URLSearchParams({ kind, value })}`, "DELETE");
    if (!r.ok) return apiError("calendar unhide", r.status, r.data);
    ctx.print({ ...(r.data ?? {}), kind, value }, () =>
      console.log(`unhidden: "${hit.title || "(untitled)"}" (${kind}) — back in the calendar listings`));
    return 0;
  }

  // check
  if (!key || args.length > 1) { console.error("usage: darth-cli meetings calendar check <event-key> [--teams]"); return 1; }
  const k = parseEventKey(key);
  if (!k) { console.error(`'${key}' is not an event key ('<eventId>|<start>') — ${EVENT_KEY_HINT}`); return 1; }
  ctx.requireWrite();
  const found = await findCalendarRow(ctx, "calendar check", key);
  if ("code" in found) return found.code;
  let row = found.row;
  if (!row) {
    // Not in the cache, but the key itself names the meeting ('<code>|<start>').
    const isTeamsCode = TEAMS_CODE_RE.test(k.head);
    if (!isTeamsCode && !MEET_CODE_RE.test(k.head)) { console.error(`No calendar event with key '${key}' in your calendar cache — ${EVENT_KEY_HINT}`); return 1; }
    row = { key, eventId: null, recurringEventId: null, title: null, start: new Date(k.startMs).toISOString(), end: null,
      meetingCode: k.head, provider: isTeamsCode ? "teams" : "gmeet", organizerEmail: null };
  }
  const teams = flags.teams === true || row.provider === "teams" || !!row.meetingCode?.startsWith("teams-");
  const req = evidenceRequest(row, teams);
  if ("error" in req) { console.error(req.error); return 1; }
  const r = await meetingsCall(ctx, req.path, "POST", req.body);
  if (!r.ok) {
    if (r.status === 404 && !teams) {
      console.error(`calendar check: Google is not connected (${typeof r.data?.error === "string" ? r.data.error : "HTTP 404"}) — connect it in the web app Settings (${webBase(ctx)}/settings), then re-run.`);
      return 1;
    }
    return apiError("calendar check", r.status, r.data);
  }
  const d = (r.data ?? {}) as EvidenceReply;
  const importRef = found.row ? found.row.key : (row.meetingCode ?? key);
  const out = evidenceLines(teams, d, importRef, tz);
  const shown = row;
  ctx.print(r.data, () => {
    console.log(`${teams ? "Microsoft" : "Google"} — "${shown.title || "(untitled)"}" ${fmtLocalDateTime(shown.start, tz)}${shown.meetingCode ? `  [${shown.meetingCode}]` : ""}`);
    for (const l of out.lines) console.log(`  ${l}`);
  });
  return out.code;
}

interface ReminderRow {
  id: number;
  kind: string;
  meetingCode: string | null;
  title: string | null;
  eventStart: string | null;
  hasRecording?: boolean;
  hasTranscript?: boolean;
}

/** The reminders card's words for one row's kind. */
function reminderKindWords(r: ReminderRow): string {
  if (r.kind === "unimported") {
    const has = [r.hasRecording ? "recording" : null, r.hasTranscript ? "transcript" : null].filter(Boolean).join("+");
    return `not imported${has ? ` (${has})` : ""}`;
  }
  if (r.kind === "sync_requested") return "colleagues need your import";
  if (r.kind === "autorec_off") return "auto-record is off — enable it in Meet before it starts";
  return r.kind;
}

/** reminders | reminders dismiss|mute <id> */
async function remindersCmd(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, raw, ...extra] = args;
  const usage = "usage: darth-cli meetings reminders [dismiss|mute <id>]";
  if (sub !== undefined && ((sub !== "dismiss" && sub !== "mute") || !raw || !/^\d+$/.test(raw) || extra.length)) { console.error(usage); return 1; }
  if (sub) ctx.requireWrite();
  const tz = localTz(ctx);
  const got = await meetingsCall(ctx, "/api/gmeet/reminders", "GET");
  if (!got.ok) return apiError("reminders", got.status, got.data);
  const rows = (Array.isArray(got.data?.reminders) ? got.data.reminders : []) as ReminderRow[];
  const when = (r: ReminderRow) => (r.eventStart ? fmtLocalDateTime(r.eventStart, tz) : "?");
  const name = (r: ReminderRow) => r.title || r.meetingCode || "Untitled meeting";

  if (!sub) {
    ctx.print(got.data, () => {
      if (got.data?.connected === false) console.error("note: Google is not connected — the reminder poller can't look at your meetings (connect it in the web app Settings).");
      if (!rows.length) { console.log("No open reminders."); return; }
      for (const r of rows) {
        const prov = r.meetingCode?.startsWith("teams-") ? "teams" : "gmeet";
        console.log(`${String(r.id).padStart(6)}  ${when(r)}  ${prov}  ${reminderKindWords(r).padEnd(30)}  ${name(r)}${r.meetingCode ? `  [${r.meetingCode}]` : ""}`);
      }
      const poll = typeof got.data?.lastPollAt === "string" ? ` · last poll ${fmtLocalDateTime(got.data.lastPollAt, tz)}` : "";
      console.log(`\n${rows.length} open reminder(s) (tz ${tz})${poll} — 'reminders dismiss <id>' = this occurrence only, 'reminders mute <id>' = never remind about this meeting again`);
    });
    return 0;
  }

  const id = Number(raw);
  const r = rows.find((x) => x.id === id);
  if (!r) { console.error(`No open reminder ${id} — 'darth-cli meetings reminders' lists them (it may be resolved already).`); return 1; }
  const res = await meetingsCall(ctx, "/api/gmeet/reminders", "PATCH", { id, action: sub, meetingCode: r.meetingCode, title: r.title, eventStart: r.eventStart });
  if (!res.ok) return apiError(`reminders ${sub}`, res.status, res.data);
  ctx.print({ ...(res.data ?? {}), id, action: sub }, () =>
    console.log(sub === "mute"
      ? `muted reminder ${id}: "${name(r)}" — never reminded about this meeting again`
      : `dismissed reminder ${id}: "${name(r)}" ${when(r)} — this occurrence only`));
  return 0;
}

interface OccurrenceRow {
  startIso: string;
  title: string | null;
  source: string;
  upcoming: boolean;
  meetingCode: string | null;
  hasRecording: boolean;
  hasTranscript: boolean;
  emptyTranscript?: boolean;
  meet?: { videoPending?: boolean; transcriptPending?: boolean } | null;
  imported: Array<{ assemblyai_id: string; title: string | null; accessible: boolean; queued?: boolean; failed?: boolean }>;
}

/** One occurrence's state, the series dialog's way: imported (with the
 * meeting id when you can open it) › upcoming › importable › nothing. */
function occurrenceStatus(o: OccurrenceRow): string {
  if (o.imported?.length) {
    const open = o.imported.filter((i) => i.accessible);
    const tag = o.imported.some((i) => i.failed) ? " (import failed)" : o.imported.some((i) => i.queued) ? " (queued)" : "";
    return open.length ? `imported → ${open.map((i) => i.assemblyai_id).join(", ")}${tag}` : `imported (no access)${tag}`;
  }
  if (o.upcoming) return "upcoming";
  const has = [o.hasRecording ? "recording" : null, o.hasTranscript ? "transcript" : null].filter(Boolean).join("+");
  const pending = o.meet?.videoPending || o.meet?.transcriptPending ? ", generating" : "";
  if (has) return `importable (${has}${pending})`;
  if (o.emptyTranscript) return "empty transcript (no speech)";
  return "nothing recorded";
}

/** series occurrences <id> [--refresh] */
async function seriesOccurrencesCmd(ctx: Ctx, flags: Record<string, string | boolean>, raw: string | undefined): Promise<number> {
  if (!raw || !/^\d+$/.test(raw)) { console.error("usage: darth-cli meetings series occurrences <id> [--refresh]"); return 1; }
  const tz = localTz(ctx);
  const r = await meetingsCall(ctx, `/api/series/${raw}/occurrences${flags.refresh === true ? "?refresh=1" : ""}`, "GET");
  if (!r.ok) {
    if (r.status === 404) { console.error(`series occurrences: no series #${raw} visible to you (owner, editor, follower or auditor only).`); return 1; }
    return apiError("series occurrences", r.status, r.data);
  }
  const d = r.data ?? {};
  const occ = (Array.isArray(d.occurrences) ? d.occurrences : []) as OccurrenceRow[];
  const c = (d.counts ?? {}) as Record<string, number | undefined>;
  ctx.print(d, () => {
    console.log(`series #${raw} "${String(d.seriesTitle ?? "")}" — ${c.total ?? occ.length} occurrence(s) on your calendar: ${c.imported ?? 0} imported · ${c.importable ?? 0} importable · ${c.bare ?? 0} nothing recorded · ${c.upcoming ?? 0} upcoming`);
    if (d.googleConnected === false) console.error("note: Google is not connected — only Teams / already-imported occurrences can show (connect it in the web app Settings).");
    if (!occ.length) console.log("No occurrences on your calendar (this meeting may not be on it).");
    for (const o of occ) {
      const src = o.source === "meet" ? "  (Meet record only)" : o.source === "imported" ? "  (member, not on your calendar)" : "";
      console.log(`  ${fmtLocalDateTime(o.startIso, tz)}  ${occurrenceStatus(o).padEnd(34)}  ${o.title || "(untitled)"}${o.meetingCode ? `  [${o.meetingCode}]` : ""}${src}`);
    }
    const swept = typeof d.sweptAt === "string" ? fmtLocalDateTime(d.sweptAt, tz) : "?";
    console.log(`\nswept ${swept} (tz ${tz}) — ${d.fromCache ? "cached; --refresh re-sweeps Google/Microsoft" : "fresh"}`);
  });
  return 0;
}

interface VocabShape { keyterms_prompt: string[]; custom_spelling: Array<{ to: string; from: string[] }> }

/** A vocab object (or `{vocab: …}`) checked with the route's own rules. */
function vocabFromJson(v: unknown): VocabShape | null {
  if (!v || typeof v !== "object") return null;
  const o = ("vocab" in (v as JsonRec) ? (v as JsonRec).vocab : v) as JsonRec | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.keyterms_prompt) || !Array.isArray(o.custom_spelling)) return null;
  const keyterms_prompt: string[] = [];
  for (const t of o.keyterms_prompt as unknown[]) {
    if (typeof t !== "string") return null;
    if (t.trim()) keyterms_prompt.push(t.trim());
  }
  const custom_spelling: VocabShape["custom_spelling"] = [];
  for (const it of o.custom_spelling as unknown[]) {
    const e = it as JsonRec | null;
    if (!e || typeof e !== "object" || typeof e.to !== "string" || !Array.isArray(e.from) || !e.from.every((s) => typeof s === "string")) return null;
    custom_spelling.push({ to: e.to, from: e.from as string[] });
  }
  return { keyterms_prompt, custom_spelling };
}

/** `vocab --set` input: JSON (`{keyterms_prompt, custom_spelling}` or
 * `{vocab: …}`), or the text `vocab` prints — one term per line, `To <- from,
 * from` = a custom spelling, blank lines and '#' lines skipped. */
function parseVocabSource(text: string): { ok: true; vocab: VocabShape } | { ok: false; error: string } {
  const t = text.trim();
  if (t.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch (e) { return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
    const v = vocabFromJson(parsed);
    return v ? { ok: true, vocab: v } : { ok: false, error: "expected { keyterms_prompt: string[], custom_spelling: [{to, from: string[]}] } (or that under \"vocab\")" };
  }
  const vocab: VocabShape = { keyterms_prompt: [], custom_spelling: [] };
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const arrow = line.indexOf("<-");
    if (arrow < 0) { vocab.keyterms_prompt.push(line); continue; }
    const to = line.slice(0, arrow).trim();
    const from = line.slice(arrow + 2).split(",").map((s) => s.trim()).filter(Boolean);
    if (!to || !from.length) return { ok: false, error: `line ${i + 1}: a spelling is 'To <- from, from' (got '${line}')` };
    vocab.custom_spelling.push({ to, from });
  }
  return { ok: true, vocab };
}

/** The vocab as text: one term per line, then 'To <- from, from' per spelling. */
function vocabLines(v: VocabShape): string[] {
  return [...v.keyterms_prompt, ...v.custom_spelling.map((s) => `${s.to} <- ${s.from.join(", ")}`)];
}

/** vocab [--org] | vocab [--org] --set --file <path|-> */
async function vocabCmd(ctx: Ctx, flags: Record<string, string | boolean>, args: string[]): Promise<number> {
  liftBoolFlags(args, flags, ["set"]); // offline prefs --set takes a value; here it is a switch
  const org = flags.org === true;
  const path = org ? "/api/vocab/org" : "/api/vocab/user";
  const which = org ? "company vocabulary" : "my vocabulary";
  const usage = "usage: darth-cli meetings vocab [--org]   |   vocab [--org] --set --file <path|->";
  if (args.length) { console.error(usage); return 1; }
  const empty: VocabShape = { keyterms_prompt: [], custom_spelling: [] };

  if (flags.set !== true) {
    if (flags.file !== undefined) { console.error(`--file only goes with --set\n${usage}`); return 1; }
    const r = await meetingsCall(ctx, path, "GET");
    if (!r.ok) return apiError("vocab", r.status, r.data);
    const d = r.data ?? {};
    const v = vocabFromJson(d.vocab) ?? empty;
    ctx.print(d, () => {
      const meta = org && d.version !== undefined
        ? ` v${String(d.version)}${typeof d.updated_at === "string" ? `, updated ${fmtLocalDateTime(d.updated_at, localTz(ctx))}` : ""}`
        : "";
      console.log(`# ${which}${meta}: ${v.keyterms_prompt.length} term(s), ${v.custom_spelling.length} spelling(s) — 'To <- from, from' = a custom spelling`);
      for (const l of vocabLines(v)) console.log(l);
    });
    return 0;
  }

  ctx.requireWrite();
  const src = readTextSource("file", str(flags.file));
  if (src === null) return 1;
  const parsed = parseVocabSource(src);
  if (!parsed.ok) { console.error(`--file: ${parsed.error}`); return 1; }
  if (!requireConsent(ctx, flags, org ? "company vocabulary" : "vocabulary")) return CONSENT_EXIT;
  const r = await meetingsCall(ctx, path, "PUT", { vocab: parsed.vocab });
  if (!r.ok) return apiError("vocab --set", r.status, r.data);
  const d = r.data ?? {};
  const v = vocabFromJson(d.vocab) ?? parsed.vocab;
  ctx.print(d, () =>
    console.log(`saved ${which}${org && d.version !== undefined ? ` v${String(d.version)}` : ""}: ${v.keyterms_prompt.length} term(s), ${v.custom_spelling.length} spelling(s) — it REPLACED the previous list`));
  return 0;
}

/** Pure helpers, exported for the tests. */
export const PARITY_B = { parseLabelColor, parseEventKey, evidenceRequest, evidenceLines, parseVocabSource, vocabLines, occurrenceStatus, reminderKindWords };

const meetings: Subcommand = {
  name: "meetings",
  summary: "Meeting transcripts, notes & recordings (darth-meetings)",
  help: HELP,
  async run(ctx, argv) {
    const { pos: rawPos, flags } = parseArgs(argv);
    liftBoolFlags(rawPos, flags, ["cascade", "exact", "cached", "details", "wait", "clear", "scratch", "resume", "separate", "keep-in-both", RETIRED_CONSENT_FLAG,
      "index", "case", "dry-run", "guess", "dismiss", "suggestions", "add-suggested", "cancel-queued", "refresh", "org"]);
    const pos = flags.help === true ? rawPos : await resolveMeetingRefs(ctx, rawPos);
    const [, cmd, ...args] = pos.length && pos[0] === "meetings" ? pos : ["", ...pos];
    if (cmd === "recordings") return recordingsCmd(ctx, flags, args);
    if (cmd === "segments" || cmd === "clips") return segmentsCmd(ctx, flags, args);
    if (cmd === "split") return splitCmd(ctx, flags, args);
    if (cmd === "unsplit") return unsplitCmd(ctx, args);
    if (!cmd || flags.help === true) { console.log(HELP); return 0; }
    if ((VERSION_VERBS as readonly string[]).includes(cmd)) return versionsCmd(ctx, flags, "meeting", cmd, args);
    if (cmd === "text" && flags.version !== undefined) return versionsCmd(ctx, flags, "meeting", "text", args);

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
        if (!["off", "mine", "all"].includes(sub)) { console.error("usage: darth-cli meetings auto-sync [explain <ref>] [off|mine|all] [--mode ...] [--report detailed-video|detailed-text|later] [--gmeet on|off] [--teams on|off]"); return 1; }
        if (!requireConsent(ctx, flags, "auto-sync")) return CONSENT_EXIT;
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
        if (!requireConsent(ctx, flags, "notifications")) return CONSENT_EXIT;
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
            // The auto-pin ladder (formerly the web app's desiredAutoLevels; the
            // web offline mode was removed 2026-10-02):
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
              console.log(`change: darth-cli meetings offline prefs --set transcripts=200,audio=20 --consent '<dcon_id>: <approved text>'   (get one: ${settingsConsentRequest(ctx, "offline prefs")})`);
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
          if (!requireConsent(ctx, flags, "offline prefs")) return CONSENT_EXIT;
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
          const other = [...ALL_FILTER_FLAGS, "no-summary", "label", "exact"].filter(f => flags[f] !== undefined);
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

      case "label-color": {
        const [target, rawColor] = args;
        const usage = "usage: darth-cli meetings label-color <label path|#id> <#rrggbb|none>   (quote '#…' — the shell reads an unquoted # as a comment; bare rrggbb works too)";
        if (!target || !rawColor || args.length > 2) { console.error(usage); return 1; }
        const color = parseLabelColor(rawColor);
        if (color === undefined) { console.error(`'${rawColor}' is not a color — #rrggbb (6 hex digits) or none\n${usage}`); return 1; }
        ctx.requireWrite();
        const { label } = await requireLabel(ctx, target);
        const r = await meetingsCall(ctx, `/api/labels/${label.id}`, "PATCH", { color });
        if (!r.ok) return apiError("label-color", r.status, r.data);
        const after = (r.data?.label ?? null) as LabelRow | null;
        ctx.print(r.data, () => console.log(color
          ? `${label.path} (#${label.id}) color ${label.color ?? "(none)"} → ${after?.color ?? color}`
          : `${label.path} (#${label.id}) color cleared — it inherits its parent's`));
        return 0;
      }

      case "reminders":
        return remindersCmd(ctx, args);

      case "vocab":
        return vocabCmd(ctx, flags, args);

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

      case "share":
        if (flags.suggestions === true || flags["add-suggested"] === true) return shareSuggestionsCmd(ctx, flags, argv, args);
        return shareCmd(ctx, flags, argv, args);

      case "get": {
        if (!args[0]) { console.error("usage: darth-cli meetings get <id>"); return 1; }
        // Who has access rides along (GET …/shares, any access): best-effort —
        // a failure there never fails 'get', the line just says so.
        const [data, sh] = await Promise.all([
          ctx.expectJson<{ transcript: any }>(ctx.api("meetings", `/api/transcripts/${args[0]}`)),
          recordingRequest(ctx, `/api/transcripts/${args[0]}/shares`, { method: "GET" }).catch((e: any) => ({ ok: false, status: 0, data: { error: String(e?.message ?? e) } })),
        ]);
        const t = data.transcript;
        const shared = sh.ok ? shareEntries(sh.data) : null;
        ctx.print(shared ? { ...t, shared_with: shared } : t, () => {
          console.log(`id:          ${t.assemblyai_id}`);
          console.log(`title:       ${t.title || t.original_filename || "(untitled)"}`);
          if (t.description) console.log(`description: ${t.description}`);
          console.log(`date:        ${t.recorded_at || t.completed_at || t.created_at}`);
          console.log(`duration:    ${fmtDuration(t.duration)}  speakers: ${t.speaker_count ?? "?"}  status: ${t.status}`);
          console.log(`access:      ${t.access}  source: ${t.source}${t.local_audio_path ? "  (audio stored locally)" : ""}`);
          console.log(`owner:       ${(sh.ok ? sh.data?.owner?.email : null) ?? t.owner_email ?? "?"}`);
          console.log(`shared with: ${shared ? sharedWithLine(shared) : `(could not read: ${sh.data?.error ?? `HTTP ${sh.status}`})`}${shared?.length ? `  — details: 'darth-cli meetings share ${t.assemblyai_id}'` : ""}`);
          if (t.scratch === true) console.log(`scratch:     yes  (temporary — trashed 30 days after creation unless kept in the web UI or linked)`);
          console.log(`notes:       ${t.auto_notes_status ?? "never run"}${t.auto_notes ? ` (${t.auto_notes.length} chars)` : ""}`);
          console.log(`report:      ${t.auto_report_status ?? "never run"}${t.auto_report ? ` (${t.auto_report.length} chars)` : ""}`);
        });
        return 0;
      }

      case "text": {
        if (!args[0]) { console.error("usage: darth-cli meetings text <id> [--index]"); return 1; }
        const rendered = await fetchTranscriptText(ctx, args[0], p => ctx.expectJson<any>(ctx.api("meetings", p)));
        if (flags.index === true) {
          // 0-based utterance index = the address 'edit-line <id> <n>' takes.
          if (!rendered.lines.length) console.error(`${args[0]} has no diarized utterances — nothing to index; printing the flat text.`);
          console.log(rendered.lines.length ? rendered.lines.map((l, i) => `[${i}] [${l.ts}] ${l.speaker}: ${l.text}`).join("\n") : rendered.text);
          return 0;
        }
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
              if (!data.series.length) return console.log("No series yet.");
              for (const r of data.series) {
                const bits = [
                  String(r.id).padStart(4),
                  (r.cadence ?? "ad-hoc").padEnd(8),
                  `${String(r.visible_member_count ?? r.member_count ?? 0).padStart(3)} yours`,
                  r.auto_enabled ? "auto" : "    ",
                ];
                const role = r.permissions?.role && r.permissions.role !== "owner" ? `  [${r.permissions.role}]` : "";
                console.log(`${bits.join("  ")}  ${r.title}${role}`);
                if (r.description) console.log(`        ${r.description}`);
                if (r.owner?.email) console.log(`        owner:    ${r.owner.email}${r.owner.isAuditor ? " (auditor — every meeting)" : ""}`);
                const pats = (r.patterns ?? []).map((p: any) => p.kind === "title" ? `/${p.regex}/i` : `invite:${(p.all ?? []).join("+")}`);
                if (pats.length) console.log(`        patterns: ${pats.join("  ")}`);
                if (r.labels?.length) console.log(`        labels:   ${r.labels.map((l: any) => l.path).join(", ")}`);
                if (r.followers?.length) console.log(`        followers: ${r.followers.map((f: any) => f.email).join(", ")}`);
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
            if (sr.description) console.log(`about:       ${sr.description}`);
            console.log(`owner:       ${data.owner?.email ?? sr.owner_email ?? "(unknown)"}${data.owner?.isAuditor ? "  (auditor — matches every meeting)" : "  (matches only meetings the owner can open)"}`);
            console.log(`editors:     ${(data.editors ?? []).map((e: any) => e.email).join(", ") || "(none)"}`);
            if (data.permissions?.role) console.log(`you:         ${data.permissions.role}${data.permissions.edit ? " (can edit)" : ""}`);
            const ai = sr.auto_import;
            console.log(`auto-import: ${ai?.enabled ? `ON (mode ${ai.mode}, report ${ai.report}, by ${ai.byEmail})` : "off"}`);
            console.log(`priority:    ${sr.priority ?? 100}`);
            const pats = (sr.patterns ?? []).map((p: any) =>
              p.kind === "title"
                ? `title /${p.regex}/i`
                : `invite ${(p.all ?? []).join("+")}${p.any?.length ? ` any(${p.any.join(",")})` : ""}${p.internalOnly ? " internal-only" : ""}${p.recurringOnly ? " recurring" : ""}${p.maxPeople ? ` ≤${p.maxPeople}` : ""}`
            );
            console.log(`patterns:    ${pats.join("  |  ") || "(none — manual members only)"}`);
            console.log(`labels:      ${(data.labels ?? []).map((l: any) => l.path).join(", ") || "(none)"}`);
            console.log(`followers:   ${(data.followers ?? []).map((f: any) => f.email).join(", ") || "(none)"}`);
            if (sr.notes) console.log(`notes:       ${sr.notes.split("\n")[0]}`);
            console.log(`members you can open (${data.members.length}):`);
            for (const m of data.members) {
              console.log(`  ${m.assemblyai_id}  ${m.recorded_at?.slice(0, 10) ?? "????-??-??"}  ${m.how === "manual" ? "[manual] " : ""}${m.title ?? ""}`);
            }
          });
          return 0;
        }
        // -- preview (read-only) -------------------------------------------
        if (sub === "preview") {
          const patterns = patternsFromFlags(argv, flags);
          if (!patterns?.length) { console.error("usage: darth-cli meetings series preview --pattern <regex> [--pattern …] [--invite-all a@x,b@y …]"); return 1; }
          const seriesId = asId(str(flags.series));
          const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/series/preview`, { method: "POST", body: JSON.stringify({ patterns, ...(seriesId ? { seriesId } : {}) }) }));
          ctx.print(data, () => {
            console.log(data.reachOf === "owner"
              ? `${data.matched} meeting(s) the series' owner can open match · ${data.visibleToYou} you can open`
              : `${data.matched} of the meetings you can open match`);
            for (const m of data.sample ?? []) console.log(`  ${m.assemblyai_id}  ${String(m.when ?? "").slice(0, 10)}  ${m.title ?? ""}`);
          });
          return 0;
        }
        // -- occurrences (read-only) ---------------------------------------
        if (sub === "occurrences") return seriesOccurrencesCmd(ctx, flags, args[1]);
        // -- mutations ----------------------------------------------------
        ctx.requireWrite();
        if (sub === "create") {
          const title = str(flags.title);
          if (!title) { console.error("usage: darth-cli meetings series create --title <t> [--description <d>] [--pattern <regex>]… [--label <path>]… [--priority N] [--follower <email>]… [--from <transcript-id>]"); return 1; }
          const body: any = { title, patterns: patternsFromFlags(argv, flags) ?? [] };
          if (str(flags.description) !== undefined) body.description = str(flags.description);
          if (str(flags.priority) !== undefined) body.priority = Number(str(flags.priority));
          const labels = allFlagValuesRaw(argv, "label");
          if (labels.length) body.labels = labels;
          const followers = allFlagValues(argv, "follower");
          if (followers.length) body.followers = followers.map((email) => ({ email }));
          if (str(flags.from)) body.fromTranscriptId = str(flags.from);
          const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/series`, { method: "POST", body: JSON.stringify(body) }));
          ctx.print(data, () => console.log(`Created series #${data.series.id} "${data.series.title}" — 'series ${data.series.id}' shows what it caught.`));
          return 0;
        }
        if (sub === "delete") {
          const id = asId(args[1]);
          if (!id) { console.error("usage: darth-cli meetings series delete <id>"); return 1; }
          await ctx.expectJson(ctx.api("meetings", `/api/series/${id}`, { method: "DELETE" }));
          if (!ctx.json) console.log("Deleted — its meetings are untouched; their series labels and follow shares came off.");
          return 0;
        }
        if (sub === "follow" || sub === "unfollow") {
          const id = asId(args[1]); const email = args[2]?.trim().toLowerCase();
          if (!id || !email) { console.error(`usage: darth-cli meetings series ${sub} <series-id> <email>${sub === "follow" ? " [--name <n>]" : ""}`); return 1; }
          if (sub === "follow") {
            const r = await ctx.expectJson<any>(ctx.api("meetings", `/api/series/${id}/followers`, {
              method: "POST", body: JSON.stringify({ email, ...(str(flags.name) ? { name: str(flags.name) } : {}) }) }));
            ctx.print(r, () => console.log(`${email} follows series #${id} — ${r.shares} meeting(s) shared read-only.`));
          } else {
            const r = await ctx.expectJson<any>(ctx.api("meetings", `/api/series/${id}/followers?${new URLSearchParams({ email })}`, { method: "DELETE" }));
            ctx.print(r, () => console.log(`${email} unfollowed series #${id} — ${r.shares} follow share(s) removed.`));
          }
          return 0;
        }
        if (sub === "editors") {
          const op = args[1]; const id = asId(args[2]); const email = args[3]?.trim().toLowerCase();
          if ((op !== "add" && op !== "rm") || !id || !email) { console.error("usage: darth-cli meetings series editors add|rm <series-id> <email> [--name <n>]"); return 1; }
          if (op === "add") {
            const r = await ctx.expectJson<any>(ctx.api("meetings", `/api/series/${id}/editors`, {
              method: "POST", body: JSON.stringify({ email, ...(str(flags.name) ? { name: str(flags.name) } : {}) }) }));
            ctx.print(r, () => console.log(r.added ? `${email} can now edit series #${id}.` : `${email} already edits series #${id}.`));
          } else {
            const r = await ctx.expectJson<any>(ctx.api("meetings", `/api/series/${id}/editors?${new URLSearchParams({ email })}`, { method: "DELETE" }));
            ctx.print(r, () => console.log(`${email} no longer edits series #${id}.`));
          }
          return 0;
        }
        if (sub === "transfer") {
          const id = asId(args[1]); const email = args[2]?.trim().toLowerCase();
          if (!id || !email) { console.error("usage: darth-cli meetings series transfer <series-id> <email>"); return 1; }
          const r = await ctx.expectJson<any>(ctx.api("meetings", `/api/series/${id}/transfer`, {
            method: "POST", body: JSON.stringify({ email }) }));
          ctx.print(r, () => console.log(`Series #${id} now belongs to ${email} — you stay on as an editor. It matches what THEY can open from now on.`));
          return 0;
        }
        if (sub === "set") {
          const id = asId(args[1]);
          if (!id) { console.error("usage: darth-cli meetings series set <id> [--title <t>] [--description <d>] [--notes <md>] [--pattern <regex>]… [--clear-patterns] [--label <path>]… [--clear-labels] [--priority N] [--auto-import on|off] [--mode ...] [--report detailed-video|detailed-text|later]"); return 1; }
          const body: any = {};
          if (str(flags.title) !== undefined) body.title = str(flags.title);
          if (str(flags.description) !== undefined) body.description = str(flags.description);
          if (str(flags.notes) !== undefined) body.notes = str(flags.notes);
          const patterns = patternsFromFlags(argv, flags);
          if (patterns) body.patterns = patterns; // replaces ALL patterns
          const labels = allFlagValuesRaw(argv, "label");
          if (labels.length) body.labels = labels; // replaces the default labels
          else if (flags["clear-labels"] === true) body.labels = [];
          if (str(flags.priority) !== undefined) body.priority = Number(str(flags.priority));
          const ai = str(flags["auto-import"]);
          if (ai !== undefined) {
            if (ai !== "on" && ai !== "off") { console.error("--auto-import must be on or off"); return 1; }
            body.autoImport = { enabled: ai === "on" };
            const mode = str(flags.mode); const report = str(flags.report);
            if (mode) body.autoImport.mode = mode;
            if (report) body.autoImport.report = report;
          }
          if (!Object.keys(body).length) { console.error("nothing to change — pass --title/--description/--notes/--pattern/--label/--priority/--auto-import"); return 1; }
          await ctx.expectJson(ctx.api("meetings", `/api/series/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
          if (!ctx.json) console.log("Updated.");
          return 0;
        }
        if (sub === "merge") {
          console.error("series merge is gone — curated series are edited (patterns / priority) in the web UI, not merged");
          return 1;
        }
        if (sub === "attach" || sub === "detach") {
          const id = asId(args[1]); const tid = args[2];
          if (!id || !tid) { console.error(`usage: darth-cli meetings series ${sub} <series-id> <transcript-id>`); return 1; }
          if (sub === "attach") {
            await ctx.expectJson(ctx.api("meetings", `/api/series/${id}/members`, {
              method: "POST", body: JSON.stringify({ transcriptId: tid }) }));
            if (!ctx.json) console.log("Attached.");
          } else {
            const qs = new URLSearchParams({ transcriptId: tid });
            if (flags.remember === true) qs.set("remember", "1");
            await ctx.expectJson(ctx.api("meetings", `/api/series/${id}/members?${qs}`, { method: "DELETE" }));
            if (!ctx.json) console.log(flags.remember === true ? "Detached — not this series (its patterns won't pull it back)." : "Detached.");
          }
          return 0;
        }
        console.error(`unknown series subcommand '${sub}' — try: series | series <id> | preview | create | set | attach | detach | follow | unfollow | editors | transfer | delete`);
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
        if (args[0] && CALENDAR_SUBS.includes(args[0])) return calendarSubCmd(ctx, flags, args[0], args.slice(1));
        const view = str(flags.view) || "unimported";
        if (view === "all" || view === "full") return calendarAll(ctx, flags, allFlagValues(argv, "calendar"));
        for (const f of ["cached", "details", "calendar"]) if (flags[f] !== undefined) { console.error(`--${f} only applies to --view all`); return 1; }
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
        if (!file) { console.error("usage: darth-cli meetings upload <file> [--event <meeting-code|event-key>] [--separate] [--title <t>] [--language <code>] [--scratch] [--wait] [--timeout <mins>]"); return 1; }
        if (!existsSync(file) || !statSync(file).isFile()) { console.error(`No such file: ${file}`); return 1; }
        // No --report here on purpose: the CLI never starts the service's AI
        // runs (generation is a human's web-UI ask); the caller's own agent
        // writes notes/reports via set-notes/set-report.
        if (flags.report !== undefined) { console.error("--report is not a CLI option: an upload gets the web UI's default generation (summary + detailed report, since 2026-09-21); a run is started by a human in the web UI, or you write the markdown yourself with 'set-notes'/'set-report'."); return 1; }
        ctx.requireWrite();
        const capMin = Number(str(flags.timeout) ?? "60");
        if (!Number.isFinite(capMin) || capMin <= 0) { console.error(`--timeout must be a number of minutes (got '${str(flags.timeout)}')`); return 1; }
        const name = basename(file); const size = statSync(file).size;
        if (size === 0) { console.error("File is empty"); return 1; }
        const isText = TEXT_DOC_RE.test(name);
        const q = new URLSearchParams();
        const ev = str(flags.event);
        if (ev) q.set("event", ev);
        // --separate: a meeting of its own even when you can already open a
        // meeting of that occurrence (the default JOINS it).
        const separate = flags.separate === true;
        if (separate && !ev) { console.error("--separate only applies with --event"); return 1; }
        if (separate) q.set("link_mode", "separate");
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
            const r = await uploadResumable(ctx, file, name, size, { eventRef: ev, languageCode: lang, scratch, separate, resumeExpected: flags.resume === true }, new UploadProgress(!ctx.json, size));
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
        const rid = bornBareId(t, id);
        if (rid) {
          // Born bare (server flag MW_RECORDINGS_BORN_BARE): no event → a
          // private RECORDING, not a meetings row. Nothing is shared; the
          // meetings verbs (get/text/speakers) do not apply until it is linked.
          const title = str(flags.title);
          if (title) {
            const r = await recordingRequest(ctx, `/api/recordings/${rid}`, { method: "PATCH", body: JSON.stringify({ title }) });
            if (!r.ok) return recordingWriteError("set title", r.status, r.data);
            t = { ...t, title };
          }
          // With --event the bytes are a recording only because they JOINED
          // the occurrence's existing meeting (one you can open): say where.
          let joinedTo: { id: string; title: string | null } | null = data?.joined?.meetingId
            ? { id: data.joined.meetingId, title: data.joined.meeting?.title ?? null }
            : null;
          if (!joinedTo && ev) {
            const v = await recordingRequest(ctx, `/api/recordings/${rid}`, {});
            const m = v.ok ? (v.data?.recording?.meetings ?? []).find((x: any) => !x.trashed) : null;
            if (m) joinedTo = { id: m.id, title: m.title ?? null };
          }
          if (joinedTo) {
            say(`uploaded and JOINED meeting ${joinedTo.id}${joinedTo.title ? ` "${joinedTo.title}"` : ""} — that occurrence already had a meeting you can open, so this is another recording of it (its text is merged when transcribed; --separate makes a meeting of its own)`);
            say(`Web: ${webBase(ctx)}/transcript/${joinedTo.id}`);
          }
          else say(`uploaded to your Recordings — ${rid}  "${t?.title ?? t?.original_filename ?? name}"  status: ${t?.status ?? "?"}  (private to you, not shared)`);
          if (t?.expires_at || t?.scratch === true) say(`temporary: expires ${t?.expires_at ? fmtDay(t.expires_at, localTz(ctx)) : "in 30 days"} unless kept ('darth-cli meetings recordings keep ${rid}') or linked`);
          if (!joinedTo) say(`link with: darth-cli meetings recordings link ${rid} <event-ref>`);
          let view: any = null;
          if (flags.wait === true && t?.status !== "ready") {
            view = await waitForRecording(ctx, rid, capMin, say);
            if (!view) return 1;
            say(`Transcribed: ${rid}  (${fmtDuration(view.duration_sec ?? null)}, ${view.speaker_count ?? "?"} speakers) — read it with 'darth-cli meetings recordings text ${rid}'`);
            if (view.suggested_event) say(`suggested event: ${view.suggested_event.title || "(untitled)"} · ${fmtLocalDateTime(view.suggested_event.startIso, localTz(ctx))}  (link with: darth-cli meetings recordings link ${rid} '${view.suggested_event.key}')`);
          }
          ctx.print({
            recording_id: rid, pseudo_id: `rec-${rid}`, status: view?.status ?? t?.status ?? null, born_bare: true,
            joined_meeting_id: joinedTo?.id ?? null,
            title: view?.title ?? t?.title ?? null, original_filename: t?.original_filename ?? null, created_at: t?.created_at ?? null,
            expires_at: view?.expires_at ?? t?.expires_at ?? null, temporary: view ? view.temporary === true : (t?.scratch === true || !!t?.expires_at),
            recording: view,
          }, () => {});
          return 0;
        }
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
        if (flags.dismiss === true) {
          // The suggested-event strip's "Not this": the suggestion stays on the
          // row, stamped as refused, and is no longer offered.
          if (!id || ref) { console.error("usage: darth-cli meetings link <id> --dismiss   (no event ref: it refuses the SUGGESTED event)"); return 1; }
          ctx.requireWrite();
          const r = await meetingsCall(ctx, `/api/transcripts/${id}`, "PATCH", { dismissSuggestedEvent: true });
          if (!r.ok) return writeError("link --dismiss", r.status, r.data, id);
          ctx.print({ ...r.data, id, dismissed: true }, () => console.log(`dismissed the suggested event on ${id} — it is not offered again; link the right one with 'link ${id} <ref>'.`));
          return 0;
        }
        if (!id || !ref) { console.error("usage: darth-cli meetings link <id> <meeting-code|event-key> [--separate]   (key = the 'key' field of 'calendar --view all --json' / --details)   |   link <id> --dismiss"); return 1; }
        ctx.requireWrite();
        const linkBody = { ...eventRefBody(ref), ...(flags.separate === true ? { mode: "separate" } : {}) };
        const res = await ctx.api("meetings", `/api/transcripts/${id}/link-event`, { method: "POST", body: JSON.stringify(linkBody) });
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
          console.error(`Link failed (HTTP ${res.status}): ${data?.error ?? "unknown error"}`);
          if (res.status === 404) console.error("Tip: 'darth-cli meetings calendar --view all --json' lists your events with their [meeting-code] and exact 'key'; a meeting code resolves to its latest PAST occurrence — use the key for an older one.");
          return 1;
        }
        if (data?.joined === true) {
          ctx.print(data, () => {
            console.log(`Joined → meeting ${data.meetingId}${data.meeting?.title ? ` "${data.meeting.title}"` : ""}: that occurrence already had a meeting you can open, so this recording was added to it and ${data.foldedMeetingId ?? id} moved to your trash (restore it from the web UI if that was wrong; --separate keeps it apart).`);
            console.log(`Web: ${webBase(ctx)}/transcript/${data.meetingId}`);
          });
          return 0;
        }
        const e = data.event ?? {};
        ctx.print(data, () => {
          const when = e.startTime ? fmtLocalDateTime(e.startTime, localTz(ctx)) : "?";
          console.log(`Linked ${data.transcript?.assemblyai_id ?? id} → "${e.title ?? "(untitled)"}"  ${when}  (${e.provider ?? "no meeting link"}, ${e.attendees ?? 0} attendees${e.enriched ? ", Meet participants captured" : ""})`);
          console.log(`Date set to the event start; title ${data.transcript?.title ? `"${data.transcript.title}"` : "(empty)"}; shared with ${data.shared ?? 0} Trames invitee(s).`);
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
        if (!id) { console.error("usage: darth-cli meetings speakers <id> [--guess]"); return 1; }
        let guess: JsonRec | null = null;
        if (flags.guess === true) {
          // The page's "Guess names": voiceprint match now (synchronous); the
          // server also restarts the speaker-ID pass when it errored / never ran.
          ctx.requireWrite();
          const r = await meetingsCall(ctx, `/api/transcripts/${id}/speakers/suggest`, "POST");
          if (!r.ok) return writeError("speakers --guess", r.status, r.data, id);
          guess = r.data ?? {};
        }
        const { t, sp } = await fetchSpeakers(ctx, id);
        ctx.print({ speaker_id_status: t?.speaker_id_status ?? null, speaker_count: t?.speaker_count ?? null, ...sp, ...(guess ? { guess } : {}) }, () => {
          if (guess) console.log(`voiceprint match ran on ${id}${guess.speakerIdStatus === "running" ? " — the speaker-ID pass is running too; guesses may still change" : ""}`);
          printSpeakers(id, t, sp);
        });
        return 0;
      }

      case "set-speakers": {
        // --from-invite / --yes are booleans; parseArgs may have swallowed the
        // next token (the id, or an assignment) as their value — hand it back.
        const local = [...args];
        for (const name of ["from-invite", "yes"]) {
          const v = flags[name];
          if (typeof v === "string") { flags[name] = true; if (local.length === 0) local.unshift(v); else local.push(v); }
        }
        const [id, ...pairs] = local;
        const fromInvite = flags["from-invite"] === true;
        const usage = "usage: darth-cli meetings set-speakers <id> <Speaker>=<Name|email|\"Name <email>\"> [...]  [--clear] [--from-invite [--yes]]   e.g. A=\"Jane Doe\" B=bea@trames.sg C=\"Wei Lin <wei@partner.example>\"";
        if (!id || (!pairs.length && flags.clear !== true && !fromInvite)) { console.error(usage); return 1; }
        ctx.requireWrite();
        const parsed: SpeakerAssignment[] = [];
        for (const p of pairs) {
          const a = parseSpeakerAssignment(p);
          if (!a) { console.error(`bad assignment '${p}' — expected <Speaker>=<Name>, <Speaker>=<email> or <Speaker>="Name <email>"`); return 1; }
          parsed.push(a);
        }
        const cur = await ctx.expectJson<SpeakersReply>(ctx.api("meetings", `/api/transcripts/${id}/speakers`));
        const current = new Map((cur.speakerLabels || []).map((l) => [l.originalSpeaker, l]));

        // --from-invite: every unconfirmed speaker whose guess names ONE person
        // (the server attached the email) is confirmed as that person. A table
        // first; nothing is written without --yes. Explicit assignments on
        // the same command win over the invite picks.
        const picks: SpeakerAssignment[] = fromInvite ? fromInvitePicks(cur) : [];
        if (fromInvite) {
          if (!picks.length && !parsed.length) { console.log(`nothing to confirm from the invite on ${id} — no unconfirmed speaker has a guess that names one invitee (see 'speakers ${id}')`); return 0; }
          if (flags.yes !== true) {
            console.log(`would confirm from the invite on ${id}:`);
            for (const p of picks) console.log(`  ${p.originalSpeaker.padEnd(10)} = ${fmtPerson(p.customName, p.email)}`);
            if (parsed.length) for (const a of parsed) console.log(`  ${a.originalSpeaker.padEnd(10)} = ${fmtPerson(a.customName, a.email)}   (from the command line)`);
            console.log("dry run — nothing written. Re-run with --yes to confirm.");
            return 0;
          }
        }

        const byOrig = new Map<string, SpeakerAssignment & { description: string }>();
        if (flags.clear !== true) for (const l of cur.speakerLabels || []) byOrig.set(l.originalSpeaker, { ...l, customName: l.customName ?? "", description: l.description ?? "" });
        for (const a of [...picks, ...parsed]) {
          // A new assignment replaces the whole identity: a name-only one
          // drops a previous email (the person changed), an email-bearing one
          // lets the server resolve the canonical name.
          byOrig.set(a.originalSpeaker, {
            originalSpeaker: a.originalSpeaker,
            customName: a.customName,
            description: byOrig.get(a.originalSpeaker)?.description ?? current.get(a.originalSpeaker)?.description ?? "",
            ...(a.email ? { email: a.email } : {}),
          });
        }
        const speakerLabels = [...byOrig.values()].filter((l) => l.customName || l.description || l.email);
        const data = await ctx.expectJson<any>(ctx.api("meetings", `/api/transcripts/${id}/speakers`, { method: "PUT", body: JSON.stringify({ speakerLabels }) }));
        ctx.print(data, () => {
          for (const l of data.speakerLabels || []) if (l.customName) console.log(`  ${String(l.originalSpeaker).padEnd(10)} = ${fmtPerson(l.customName, l.email)}`);
          console.log(`${(data.speakerLabels || []).filter((l: any) => l.customName).length} speaker(s) confirmed — 'text ${id}' now uses these names; voiceprints enrol in the background.`);
        });
        return 0;
      }

      case "help": {
        const verb = args[0];
        if (!verb) { console.log(HELP); return 0; }
        // "help calendar hide" → that sub-verb's lines; else the first word's.
        const lines = (args.length > 1 ? helpForVerb(args.join(" ")) : null) ?? helpForVerb(verb);
        if (!lines) { console.error(`no verb '${verb}' — 'darth-cli meetings --help' lists them`); return 1; }
        console.log(lines);
        return 0;
      }

      case "generate":
      case "regenerate":
        return generateCmd(ctx, flags, args);

      case "hold": {
        const id = args[0];
        if (!id) { console.error("usage: darth-cli meetings hold <id>   (stops the automatic summary of a manual upload; the review gate stays)"); return 1; }
        ctx.requireWrite();
        const res = await ctx.api("meetings", `/api/transcripts/${id}/notes/hold`, { method: "POST" });
        const data = await readJsonSafe(res);
        if (!res.ok) return writeError("hold", res.status, data, id);
        ctx.print(data, () => console.log(`held ${id} — the summary will not be written automatically; generate it with 'darth-cli meetings generate ${id} --yes' or in the web UI.`));
        return 0;
      }

      case "add-person": {
        const [name, email] = args;
        if (!name || !email) { console.error("usage: darth-cli meetings add-person \"<Full Name>\" <email>"); return 1; }
        if (!EMAIL_SHAPE.test(email.trim().toLowerCase())) { console.error(`'${email}' is not an email address`); return 1; }
        ctx.requireWrite();
        const res = await ctx.api("meetings", "/api/people", { method: "POST", body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase() }) });
        const data = await readJsonSafe(res);
        if (res.status === 409 && data?.person) {
          // The dialog's "already belongs to X" step: the existing record is
          // the answer, nothing is forked.
          ctx.print({ ...data, created: false }, () => console.log(`${data.person.email} already belongs to ${data.person.name} (${data.person.source === "trames" ? "Trames directory" : "custom"}) — use that name; nothing created.`));
          return 0;
        }
        if (!res.ok) return writeError("add-person", res.status, data);
        ctx.print({ ...data, created: true }, () => console.log(`added ${data.person?.name ?? name} <${data.person?.email ?? email}> to the people directory — 'set-speakers <id> A=${data.person?.email ?? email}' names a speaker as them.`));
        return 0;
      }

      case "set-description": {
        const id = args[0];
        if (!id || args.length > 1) { console.error("usage: darth-cli meetings set-description <id> --file <md|->   ('-' = stdin; an empty file clears it)"); return 1; }
        ctx.requireWrite();
        const raw = readTextSource("file", str(flags.file));
        if (raw === null) return 1;
        const description = raw.trim(); // the page trims on save too
        const r = await meetingsCall(ctx, `/api/transcripts/${id}`, "PATCH", { description });
        if (!r.ok) return writeError("set-description", r.status, r.data, id);
        ctx.print({ ...r.data, id, description_chars: description.length }, () =>
          console.log(description ? `description set (${description.length} chars)` : "description cleared"));
        return 0;
      }

      case "keep": {
        const ids = [...new Set(args.flatMap(a => a.split(",")).map(s => s.trim()).filter(Boolean))];
        if (!ids.length) { console.error("usage: darth-cli meetings keep <id>[,<id>…]   (a temporary row → a permanent one, the web UI's Keep)"); return 1; }
        ctx.requireWrite();
        let exit = 0;
        const results: JsonRec[] = [];
        for (const id of ids) {
          const r = await meetingsCall(ctx, `/api/transcripts/${id}`, "PATCH", { scratch: false });
          if (!r.ok) {
            const code = writeError("keep", r.status, r.data, id);
            if (code === 3 || exit === 0) exit = code;
            results.push({ id, kept: false, status: r.status, error: r.data?.error ?? null });
            continue;
          }
          results.push({ id, kept: true });
          if (!ctx.json) console.log(`kept ${id} — permanent now (not temporary; no 30-day trash)`);
        }
        if (ctx.json) console.log(JSON.stringify(ids.length === 1 ? results[0] : results));
        return exit;
      }

      case "unlink": {
        const id = args[0];
        if (!id || args.length > 1) { console.error("usage: darth-cli meetings unlink <id>   (detach its calendar event; the recording, title, date and notes stay)"); return 1; }
        ctx.requireWrite();
        const r = await meetingsCall(ctx, `/api/transcripts/${id}`, "PATCH", { unlinkEvent: true });
        if (!r.ok) return writeError("unlink", r.status, r.data, id);
        const removed = Array.isArray(r.data?.sharesRemoved) ? (r.data.sharesRemoved as unknown[]).map(String) : [];
        ctx.print({ ...r.data, id, sharesRemoved: removed }, () =>
          console.log(`unlinked ${id} from its calendar event — ${removed.length} share(s) the link had created removed${removed.length ? `: ${removed.join(", ")}` : ""}. Link the right event with 'link ${id} <ref>'.`));
        return 0;
      }

      case "fetch-recording": {
        const id = args[0];
        if (!id || args.length > 1) { console.error("usage: darth-cli meetings fetch-recording <id>   (pull the recording from Google Drive / Microsoft 365)"); return 1; }
        ctx.requireWrite();
        if (!ctx.json) console.error(`fetching the recording of ${id} from the provider — a long call can take minutes…`);
        const r = await meetingsCall(ctx, `/api/transcripts/${id}/fetch-audio`, "POST", {});
        // 401 here is the caller's GOOGLE link, not the darth token.
        if (r.status === 401 && /google/i.test(String(r.data?.error ?? ""))) { console.error(`fetch-recording failed: ${String(r.data?.error)}`); return 1; }
        if (!r.ok) return writeError("fetch-recording", r.status, r.data, id);
        ctx.print({ ...r.data, id }, () => {
          if (r.data?.already === true) console.log(`${id} already has its recording stored — nothing fetched.`);
          else console.log(`fetched the recording of ${id}${typeof r.data?.bytes === "number" ? ` (${fmtMB(r.data.bytes)} MB)` : ""} — 'audio ${id}' / 'frame ${id} <ts>' work now.`);
        });
        return 0;
      }

      case "retry": {
        const id = args[0];
        if (!id || args.length > 1) { console.error("usage: darth-cli meetings retry <id>   (retry a failed hand-off to transcription)"); return 1; }
        ctx.requireWrite();
        const r = await meetingsCall(ctx, `/api/transcripts/${id}/retry-ingest`, "POST");
        if (!r.ok) return writeError("retry", r.status, r.data, id);
        ctx.print({ ...r.data, id, status: r.status }, () => console.log(`retrying ${id} (HTTP ${r.status}) — the row is back to 'uploading'; 'get ${id}' shows the status.`));
        return 0;
      }

      case "activity": {
        const id = args[0];
        if (!id || args.length > 1) { console.error("usage: darth-cli meetings activity <id> [--limit N]   (N 1-200, default 50)"); return 1; }
        let limit: number | null = null;
        if (flags.limit !== undefined) {
          const raw = str(flags.limit) ?? "";
          limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) { console.error(`--limit must be a whole number 1-200 (got '${raw}')`); return 1; }
        }
        const r = await meetingsCall(ctx, `/api/transcripts/${id}/activity${limit ? `?limit=${limit}` : ""}`, "GET");
        if (!r.ok) return writeError("activity", r.status, r.data, id);
        const events = Array.isArray(r.data?.events) ? (r.data.events as JsonRec[]) : [];
        ctx.print(r.data, () => {
          if (!events.length) { console.log(`no activity recorded on ${id}`); return; }
          const tz = localTz(ctx);
          for (const e of events) {
            const who = asStr(e.user_name) ? `${String(e.user_name)} <${String(e.user_email ?? "")}>` : String(e.user_email ?? "?");
            const d = fmtDetails(e.details);
            console.log(`${asStr(e.at) ? fmtLocalDateTime(String(e.at), tz) : "?"}  ${who}  ${String(e.action ?? "?")}${d ? `  — ${d}` : ""}`);
          }
          const viewers = Array.isArray(r.data?.recentViewers) ? (r.data.recentViewers as JsonRec[]) : [];
          console.log(`\n${events.length} event(s), newest first${viewers.length ? ` · viewed in the last 30 days by ${viewers.map((v) => String(v.user_email ?? "?")).join(", ")}` : ""}`);
        });
        return 0;
      }

      case "ai-runs": {
        const id = args[0];
        if (!id || args.length > 1) { console.error("usage: darth-cli meetings ai-runs <id>"); return 1; }
        const r = await meetingsCall(ctx, `/api/transcripts/${id}/ai-runs`, "GET");
        if (!r.ok) return writeError("ai-runs", r.status, r.data, id);
        const runs = Array.isArray(r.data?.runs) ? (r.data.runs as JsonRec[]) : [];
        const totals = (r.data?.totals ?? {}) as JsonRec;
        ctx.print(r.data, () => {
          if (!runs.length) { console.log(`no AI runs on ${id}`); return; }
          const tz = localTz(ctx);
          for (const x of runs) {
            const dur = typeof x.duration_ms === "number" ? `${Math.round(x.duration_ms / 1000)}s` : "";
            const tok = x.input_tokens != null || x.output_tokens != null ? `${String(x.input_tokens ?? "?")} in / ${String(x.output_tokens ?? "?")} out` : "";
            const cols = [String(x.kind ?? "?"), String(x.status ?? "?"), asStr(x.model) ?? "", fmtCost(x.cost_usd), dur, tok, asStr(x.triggered_by_email) ? `by ${String(x.triggered_by_email)}` : ""].filter(Boolean);
            console.log(`${asStr(x.created_at) ? fmtLocalDateTime(String(x.created_at), tz) : "?"}  ${cols.join("  ")}${asStr(x.error) ? `  — ${oneLine(String(x.error), 140)}` : ""}`);
          }
          console.log(`\n${String(totals.runs ?? runs.length)} run(s), ${String(totals.errors ?? 0)} error(s)${fmtCost(totals.cost_usd) ? `, ${fmtCost(totals.cost_usd)} in total` : ""}${runs.length < Number(totals.runs ?? 0) ? ` (newest ${runs.length} shown)` : ""}`);
        });
        return 0;
      }

      case "attach": {
        const [id, file, ...extra] = args;
        const textFlag = flags.text;
        const usage = "usage: darth-cli meetings attach <id> <file> [--title \"…\"]   |   attach <id> --text <file|-> [--title \"…\"]";
        if (!id || extra.length || (file && textFlag !== undefined) || (!file && textFlag === undefined)) { console.error(usage); return 1; }
        const title = str(flags.title)?.trim() || undefined;
        if (textFlag !== undefined) {
          const text = readTextSource("text", str(textFlag));
          if (text === null) return 1;
          if (!text.trim()) { console.error("--text: the text is empty"); return 1; }
          ctx.requireWrite();
          const r = await meetingsCall(ctx, `/api/transcripts/${id}/attachments`, "POST", { kind: "text", ...(title ? { title } : {}), text });
          if (!r.ok) return writeError("attach", r.status, r.data, id);
          const a = (r.data?.attachment ?? {}) as JsonRec;
          ctx.print(r.data, () => console.log(`attached #${String(a.id ?? "?")} "${String(a.title ?? title ?? "Pasted notes")}" (text, ${text.trim().length} chars) to ${id} — the next summary run reads it.`));
          return 0;
        }
        if (!existsSync(file!) || !statSync(file!).isFile()) { console.error(`No such file: ${file}`); return 1; }
        const size = statSync(file!).size;
        if (size === 0) { console.error("File is empty"); return 1; }
        if (size > 25 * 1024 * 1024) { console.error(`File is ${fmtMB(size)} MB — attachments are capped at 25 MB`); return 1; }
        ctx.requireWrite();
        const name = basename(file!);
        // Never application/json: that is the server's {kind:'text'} branch.
        const mime = mimeFor(name);
        const res = await ctx.api("meetings", `/api/transcripts/${id}/attachments`, {
          method: "POST",
          body: new Blob([readFileSync(file!)]),
          headers: {
            "content-type": mime === "application/json" ? "application/octet-stream" : mime,
            "x-filename": encodeURIComponent(name),
            ...(title ? { "x-title": encodeURIComponent(title) } : {}),
          },
        });
        const data = await readJsonSafe(res);
        if (!res.ok) return writeError("attach", res.status, data, id);
        const a = (data?.attachment ?? {}) as JsonRec;
        const ext = asStr(a.extraction_status);
        ctx.print(data, () => console.log(`attached #${String(a.id ?? "?")} "${String(a.title ?? title ?? name)}" (${name}, ${fmtMB(size)} MB${ext === "ok" ? ", text extracted" : ext === "failed" ? ", text extraction FAILED — the summary cannot read it" : ext === "none" ? ", no text in it" : ""}) to ${id}.`));
        return 0;
      }

      case "attachment-rm": {
        const [id, attId] = args;
        if (!id || !attId || args.length > 2 || !/^\d+$/.test(attId)) { console.error("usage: darth-cli meetings attachment-rm <id> <attachmentId>   (ids from 'attachments <id>')"); return 1; }
        ctx.requireWrite();
        const r = await meetingsCall(ctx, `/api/transcripts/${id}/attachments/${attId}`, "DELETE");
        if (r.status === 404) { console.error(`attachment-rm failed: not found — no attachment #${attId} on a meeting ${id} visible to you ('attachments ${id}' lists them).`); return 1; }
        if (!r.ok) return writeError("attachment-rm", r.status, r.data, id);
        ctx.print({ ...r.data, id, attachmentId: Number(attId) }, () => console.log(`removed attachment #${attId} from ${id}`));
        return 0;
      }

      case "edit-line": {
        const [id, nRaw, ...extra] = args;
        const text = str(flags.text);
        if (!id || !nRaw || extra.length || text === undefined || !/^\d+$/.test(nRaw)) { console.error("usage: darth-cli meetings edit-line <id> <n> --text \"…\"   (n = the [n] of 'text <id> --index')"); return 1; }
        ctx.requireWrite();
        const n = Number(nRaw);
        const cur = await fetchLinesAndEdits(ctx, id);
        if (!cur.ok) return cur.code;
        const line = cur.lines[n];
        if (!line) { console.error(`${id} has ${cur.lines.length} utterance(s) (0-${Math.max(0, cur.lines.length - 1)}) — no line ${n}. 'text ${id} --index' shows the addresses.`); return 1; }
        const before = effectiveText(line.text, cur.edits, n);
        const r = await meetingsCall(ctx, `/api/transcripts/${id}/edits`, "PATCH", { utteranceIndex: n, text });
        if (!r.ok) return writeError("edit-line", r.status, r.data, id);
        ctx.print({ ...r.data, id, utteranceIndex: n, before, after: text }, () => {
          console.log(`[${n}] [${line.ts}] ${line.speaker}`);
          console.log(`  before: ${oneLine(before, 200)}`);
          console.log(`  after:  ${oneLine(text, 200)}`);
        });
        return 0;
      }

      case "replace": {
        const [id, find, replaceWith, ...extra] = args;
        if (!id || find === undefined || replaceWith === undefined || extra.length) { console.error("usage: darth-cli meetings replace <id> <find> <with> [--case] [--dry-run]   (flags after the arguments; '' as <with> deletes)"); return 1; }
        if (!find) { console.error("<find> is empty"); return 1; }
        const dryRun = flags["dry-run"] === true;
        const caseSensitive = flags.case === true;
        if (!dryRun) ctx.requireWrite();
        const cur = await fetchLinesAndEdits(ctx, id);
        if (!cur.ok) return cur.code;
        const raws = cur.lines.map((l) => l.text);
        const matches = findMatchesIn(raws, cur.edits, find, caseSensitive);
        const { next, changed } = replaceAllEdits(raws, cur.edits, matches, replaceWith);
        const summary = { id, find, with: replaceWith, caseSensitive, matches: matches.length, lines: changed.map((c) => ({ index: c.i, count: c.n, before: c.before, after: c.after })) };
        if (!matches.length) {
          ctx.print({ ...summary, written: false }, () => console.log(`no ${caseSensitive ? "case-sensitive " : ""}match for ${JSON.stringify(find)} in ${id} — nothing to replace.`));
          return 0;
        }
        const show = () => {
          for (const c of changed) {
            const l = cur.lines[c.i]!;
            console.log(`[${c.i}] [${l.ts}] ${l.speaker}${c.n > 1 ? `  (${c.n}×)` : ""}`);
            console.log(`  before: ${oneLine(c.before, 200)}`);
            console.log(`  after:  ${oneLine(c.after, 200)}`);
          }
        };
        if (dryRun) {
          ctx.print({ ...summary, written: false, dryRun: true }, () => {
            show();
            console.log(`dry run — nothing written. ${matches.length} match(es) in ${changed.length} line(s); re-run without --dry-run to replace them all.`);
          });
          return 0;
        }
        const r = await meetingsCall(ctx, `/api/transcripts/${id}/edits`, "PUT", { edits: next });
        if (!r.ok) return writeError("replace", r.status, r.data, id);
        ctx.print({ ...summary, written: true }, () => {
          show();
          console.log(`replaced ${matches.length} match(es) in ${changed.length} line(s) of ${id} (the raw words are kept; edits are a layer the page shows).`);
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
        if (!id || args.length > 1) { console.error(`usage: darth-cli meetings ${cmd} <id>${cmd === "trash" ? " [--cancel-queued]" : ""}`); return 1; }
        const cancelQueued = flags["cancel-queued"] === true;
        if (cancelQueued && cmd !== "trash") { console.error("--cancel-queued goes with 'trash' (it cancels a queued import)"); return 1; }
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
          if (cancelQueued) {
            // The listing's "Cancel queued import": a 'waiting' placeholder has
            // nothing transcribed yet — the server deletes it for good. An
            // 'uploading' one is mid-flight and stays refused.
            if (t?.status !== "waiting") { console.error(`--cancel-queued only cancels a queued import (status waiting); ${id} is ${t?.status ?? "?"}${t?.status === "uploading" ? " — still uploading, nothing to cancel from here" : " — drop the flag to move it to the trash"}.`); return 1; }
            const res = await ctx.api("meetings", `/api/transcripts/${id}`, { method: "DELETE" });
            const data = await readJsonSafe(res);
            if (!res.ok) return writeError("trash --cancel-queued", res.status, data, id);
            ctx.print({ ...data, id, action: "cancel-queued" }, () => console.log(`cancelled the queued import ${id} — the placeholder is deleted (nothing had been transcribed).`));
            return 0;
          }
          if (t?.status === "uploading" || t?.status === "waiting") { console.error(`${id} is a placeholder (status ${t.status}) — the server would delete it for good, not trash it.${t.status === "waiting" ? ` To cancel the queued import: 'darth-cli meetings trash ${id} --cancel-queued'.` : " Use the web UI if that is what you want."}`); return 1; }
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
