/**
 * The Recordings surface's two small rules that are not markup (pure; the
 * page and the tests share them).
 *
 * 1. The registry → recording swap (2026-10-02). A Darth Recorder upload
 *    creates the caller's `recordings` row when it OPENS (`POST /api/uploads`
 *    with `recorderRecordingId`), and from that moment `GET /api/recordings`
 *    lists it as kind 'recording' — which offers Link to meeting… / Make a
 *    meeting while the bytes are still moving — instead of the Mac row
 *    (kind 'registry', which has no server recording to act on). The page
 *    used to refetch only on upload_done, so a list loaded before the upload
 *    began kept the Mac row, with nothing to press, until the upload ended
 *    (Ivan, 2026-10-02 09:31–09:32 SGT). Now a Mac row seen uploading — the
 *    tray's live progress, or the server's own `status = 'uploading'` when
 *    the page is open on another device — asks for a refetch, then a few
 *    more on a backoff until the row has turned into its recording.
 *
 * 2. What a 'linked' row says about itself (section=linked).
 */

/** Upload state per registry id, as the companion folds it. */
export type LiveUploads = Record<string, { status: string } | undefined>;

/**
 * The registry ids on screen as Mac rows whose upload is under way — each
 * one is a row the server will hand back as a recording once the upload has
 * opened. Sorted, so a caller can compare the joined key cheaply.
 */
export function registryItemsAwaitingSwap(
  items: ReadonlyArray<{ kind: string; registry?: { id: string; status: string } | null }>,
  uploads: LiveUploads
): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind !== 'registry' || !it.registry) continue;
    const live = uploads[it.registry.id]?.status === 'uploading';
    if (live || it.registry.status === 'uploading') out.push(it.registry.id);
  }
  return out.sort();
}

/**
 * Delay before refetch attempt `n` (0-based) for the same set of awaiting
 * rows, or null = stop. The first is almost immediate (the tray's first
 * progress tick comes after the OPEN, so the row is usually there); the
 * rest cover a slow open — hashing a large file happens before it — and a
 * page with no tray connection. About a minute in all; after that the
 * upload_done event (or the Refresh button) is what moves the list.
 */
export const SWAP_REFRESH_DELAYS_MS = [300, 1500, 3000, 5000, 5000, 10_000, 10_000, 15_000] as const;

export function swapRefreshDelay(attempt: number): number | null {
  return attempt >= 0 && attempt < SWAP_REFRESH_DELAYS_MS.length ? SWAP_REFRESH_DELAYS_MS[attempt]! : null;
}

/** A meeting a linked recording is in, as the API serves it. */
export interface LinkedMeetingWire {
  assemblyai_id: string;
  title: string | null;
  recorded_at: string | null;
}

/**
 * The recording's own facts, one line: date · duration · source app · size.
 * Empty parts drop out; the formatters are the page's.
 */
export function linkedRecordingFacts(
  r: {
    started_at: string | null;
    created_at: string;
    duration_sec: number | null;
    bytes: number | null;
    source_app?: string | null;
    source_kind: string;
  },
  fmt: { when: (iso: string) => string; duration: (s: number) => string; bytes: (n: number) => string }
): string {
  const app = r.source_app?.trim() || (r.source_kind === 'recorder' ? 'Darth Recorder' : 'Uploaded file');
  return [
    fmt.when(r.started_at ?? r.created_at),
    r.duration_sec ? fmt.duration(r.duration_sec) : null,
    app,
    r.bytes ? fmt.bytes(r.bytes) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Data scrum · Thu 2 Oct 09:00" — or "Untitled meeting · …". */
export function linkedMeetingLabel(m: LinkedMeetingWire, when: (iso: string) => string): string {
  const title = m.title?.trim() || 'Untitled meeting';
  const at = m.recorded_at ? when(m.recorded_at) : '';
  return at ? `${title} · ${at}` : title;
}
