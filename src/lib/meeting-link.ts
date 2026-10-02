/**
 * "Copy link" for a meeting (README "Copy link"). Most people read Darth
 * Meetings inside the Darth desktop shell, which has no URL bar — so the page
 * header, the listing row's ⋯ menu and ⌘⇧C copy the link for them.
 *
 * The link is the meeting's PERMANENT one, `/m/<meeting uuid>` (migration
 * 031: the ledger id never changes across provider-id renames; the route
 * redirects to the current transcript after its own access check). When the
 * ledger has no row for the transcript (or the lookup fails) the link falls
 * back to `/transcript/<id>`, which still works today.
 *
 * Pure helpers first (tested), then the browser-only bits: the lookup
 * (`GET /api/meetings/resolve?any=<id>`, caller-scoped, ids only) and the
 * clipboard write.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MeetingLinkIds {
  /** The meetings-ledger uuid (`meetings.id`), when known. */
  meetingUuid?: string | null;
  /** The transcript route id (`/transcript/<id>`). */
  transcriptId: string;
}

/** `/m/<uuid>` when the uuid looks like one, else `/transcript/<id>`. Pure. */
export function meetingLinkPath({ meetingUuid, transcriptId }: MeetingLinkIds): string {
  if (meetingUuid && UUID_RE.test(meetingUuid)) return `/m/${meetingUuid.toLowerCase()}`;
  return `/transcript/${encodeURIComponent(transcriptId)}`;
}

/** The absolute link on `origin` (trailing slashes dropped). Pure. */
export function meetingLinkUrl(origin: string, ids: MeetingLinkIds): string {
  return `${origin.replace(/\/+$/, '')}${meetingLinkPath(ids)}`;
}

/** True for ⌘⇧C (macOS) / Ctrl+Shift+C — the page's "copy link" key. Pure. */
export function isCopyLinkShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return e.shiftKey && !e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c';
}

// --- browser-only -----------------------------------------------------------

/** The absolute URL of a path on this page's origin. */
export function absoluteUrl(path: string): string {
  return `${window.location.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

const uuidCache = new Map<string, string | null>();

/**
 * The meeting uuid for a transcript id, or null (no ledger row, no access,
 * network failure). Cached per id for the page's lifetime; a failure other
 * than "not found" is not cached, so the next copy asks again.
 */
export async function resolveMeetingUuid(transcriptId: string): Promise<string | null> {
  if (uuidCache.has(transcriptId)) return uuidCache.get(transcriptId) ?? null;
  try {
    const res = await fetch(`/api/meetings/resolve?any=${encodeURIComponent(transcriptId)}`, {
      credentials: 'include',
    });
    if (res.status === 404) {
      uuidCache.set(transcriptId, null);
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { meetingId?: unknown };
    const id = typeof body.meetingId === 'string' && UUID_RE.test(body.meetingId) ? body.meetingId : null;
    uuidCache.set(transcriptId, id);
    return id;
  } catch {
    return null;
  }
}

/** The meeting's absolute permanent link (falls back to /transcript/<id>). */
export async function resolveMeetingLink(transcriptId: string, knownUuid?: string | null): Promise<string> {
  const meetingUuid = knownUuid ?? (await resolveMeetingUuid(transcriptId));
  return meetingLinkUrl(window.location.origin, { meetingUuid, transcriptId });
}

function copyViaTextarea(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Put `text` on the clipboard. A Promise is fine: where the browser supports
 * a ClipboardItem with a pending value (Chrome / Electron, Safari) the write
 * is claimed inside the click and filled when the value lands, so Safari's
 * user-activation rule holds across the lookup; elsewhere the value is
 * awaited and written. Falls back to a hidden textarea + execCommand.
 * Resolves true when something was copied. Never throws.
 */
export async function copyText(value: string | Promise<string>): Promise<boolean> {
  if (typeof value !== 'string') {
    try {
      const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (Item && navigator.clipboard?.write) {
        const blob = value.then((t) => new Blob([t], { type: 'text/plain' }));
        await navigator.clipboard.write([new Item({ 'text/plain': blob })]);
        return true;
      }
    } catch {
      /* fall through: await the value and write it as text */
    }
    let text: string;
    try {
      text = await value;
    } catch {
      return false;
    }
    return copyText(text);
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* blocked — try the textarea */
  }
  return copyViaTextarea(value);
}
