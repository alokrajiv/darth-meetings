# Handoff: transcript-page stale state on navigation + tab counts under calendar layers

Written 2026-08-26 for a fresh session. Two independent items; do them in
order (A is a confirmed bug, B is a UX inconsistency needing one design call).
Neither touches privacy scoping — that work is done (commits af3d364,
416e84c; memory `privacy-caller-scoping-gate`). Repo rules that apply: bun
only, plain commit messages with no attribution trailers, `git status -s` +
`git diff --cached` before every commit, GUARDED-DEPLOY probe
(`pgrep 'claude-agent-sd[k]'` on the VM) before `pm2 restart`.

---

## A. `/transcript/[id]` keeps the previous transcript's state after navigation (CONFIRMED BUG)

### Symptom (reported by Alok, 2026-08-25)
Play audio on transcript A, click through to transcript B (e.g. one still
importing). B's URL shows A's title/speakers/audio for a while; a speaker
sample plays A's audio. It can also *re-appear* after B loaded.

### Root cause — `src/app/transcript/[id]/page.tsx`
Three stacked issues in `TranscriptDetailPage`:

1. **No remount between transcripts.** `/transcript/A → /transcript/B` is the
   same App Router segment, so the component instance survives with all ~30
   `useState`s. `row` keeps A's data until `loadAll()` for B resolves
   (`loadAll` is a `useCallback([transcriptId])`, re-run by the effect at
   ~line 480). While B is importing that window is the whole time you look
   at the page.
2. **Audio player keyed by video part, not transcript** — `<AudioPlayer
   key={activePart} src={`/api/transcripts/${row.assemblyai_id}/audio`}>`
   at ~line 2570. Same `<audio>` element is reused across transcripts; it
   only swaps `src` once `row` finally changes.
3. **Stale-reload race, no guard.** Live SSE events (`useLiveEvents`, ~line
   486) arm a 1 s debounce timer `liveReloadTimer` that calls
   `loadAll({silent:true})`. The timer is cleared only by the *next* event
   (line ~491), never when `transcriptId` changes, and the callback closes
   over the OLD `loadAll` (old id). Sequence: event for A arrives → user
   navigates to B → timer fires → old `loadAll` fetches A → `setRow(A)` on
   B's page. Nothing corrects it until B emits an event or a manual refresh.
   Separately, `loadAll` has no "is this response still for the current id"
   check, so a slow in-flight A fetch can clobber B the same way.

### Fix (small, surgical)

1. **Force a remount per transcript id.** Rename the current default export
   to an inner component that takes `transcriptId` as a prop, and add a thin
   default export:

   ```tsx
   export default function TranscriptDetailPage({ params }: TranscriptDetailPageProps) {
     const { id } = use(params);
     return <TranscriptDetailInner key={id} transcriptId={id} />;
   }
   ```
   Inside the inner component replace `const { id: transcriptId } = use(params);`
   with the prop. Grep the file for any other `params` use (there should be
   none). Effect: every navigation resets all state, unmounts the player
   (audio stops instantly), and the old instance's timers/`setRow` become
   no-ops on an unmounted component (React 18 is silent about it).

2. **Stale-response guard in `loadAll`** (belt and braces — a timer armed
   in the old instance still fires a network request; harmless, but cheap
   to make explicit):
   ```ts
   const liveIdRef = useRef(transcriptId);
   liveIdRef.current = transcriptId;
   // in loadAll, after each await:
   if (liveIdRef.current !== transcriptId) return;
   ```
   and clear `liveReloadTimer` in an effect cleanup keyed on `transcriptId`.

3. Consider `key={`${row.assemblyai_id}-${activePart}`}` on `<AudioPlayer>`
   for the same reason — optional once (1) is in.

### Verify
- Local: `ssh -f -N -L 5433:localhost:5432 azureuser@172.17.0.6`, scrubbed
  `bun run dev` (see memory `local-dev-playwright-recipe`), Playwright with
  the SSO cookie. Open a completed transcript, press play, client-navigate
  (in-app link, NOT a full reload) to a different transcript: audio must
  stop immediately and the new page must never show the old title.
- Race repro: in the browser console, dispatch nothing — instead trigger a
  collaborator edit on A from a second tab (or `curl` a PATCH to
  `/api/transcripts/A/edits` as another user) then navigate within 1 s. With
  the fix the old row never lands on B.
- `bunx tsc --noEmit`, `bun test`, `bun run build` all clean before deploy.

---

## B. Archive tab counts shown while a calendar layer is active (UX inconsistency — design call)

### What Jac saw (2026-08-25 screenshot)
Layer dropdown = **Not imported** (calendar rows listed), but the tab strip
still shows **All 121 / Mine 40 / Shared 81** — those are the *archive*
(imported-transcript) counts for a list that isn't on screen. She read it as
"the filter shows all". Alok asked whether that's a bug.

### Facts established
- The archive counts are correct and per-user (41 owned / 82 shared for
  her, verified in DB), and they DO respect every filter — people, provider,
  speaker, label, date range and search all flow through `rangeAndSearch()`
  in `src/db-ops/transcripts.ts:320-336`, which the count query at
  ~line 542 uses. **Only the comment at line 520 is stale** ("respect the
  from/to + q filters") — update it to say all filters.
- The calendar layers have their own counts: `countCalendarMeetings()` in
  `src/db-ops/calendar-event-cache.ts` returns `{unimported, norec}` and
  also respects the shared filters. The listing route already returns them
  (`counts` in `/api/calendar-meetings`).

### The decision to make (pick one, then it's a small UI change in the listing page / tab strip component)
1. **Hide or dim the All/Mine/Shared/Trash tabs when a calendar layer is
   selected**, and show the layer's own count next to the layer name
   (e.g. "Not imported · 2"). Cleanest — the tabs only ever describe the
   archive. Recommended.
2. Keep the tabs visible but make them switch the layer back to the
   archive on click, with the count badges greyed while a calendar layer is
   active.

Find the tab strip in `src/app/page.tsx` / the listing component (grep for
`Shared` + `counts.shared`), and the layer dropdown (grep `Not imported`).
The `counts` from `/api/calendar-meetings` are already fetched when a layer
is active — no API work needed.

---

## Out of scope / already handled elsewhere
- Row titles disappearing under many badges — fixed 615cf0e (CSS: title had
  no min width next to shrink-0 badges).
- "Wrong meeting" speakers on `alok <> swaralee - lp` — not a bug: the 1:1
  recording contains played-back LP-Global audio (Mandy/Nicolas are real),
  and diarization split Alok into two clusters, one of which the voiceprint
  sidecar matched to Ivan Seow at 0.87 → **re-enroll Ivan's voiceprint**
  (likely contaminated with Alok's speech). Separate small task.
- Privacy follow-ups deliberately left open (labels rail `Series/*` titles,
  SSE fan-out ids, unimported `series_count`) — listed in memory
  `privacy-caller-scoping-gate`.
