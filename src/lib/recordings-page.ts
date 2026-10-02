/**
 * The Recordings surface's paginated listing — the pure half (no server
 * imports; the page, the CLI contract and the tests share it).
 *
 * `GET /api/recordings?mine=1` pages NEWEST FIRST over one merged set of the
 * caller's own recordings that belong to no meeting:
 *
 *   kind 'recording' — a STANDALONE recording (design P7, born by an
 *                      unlinked upload) that no live meeting holds;
 *   kind 'meeting'   — a LEGACY bare upload: a `transcripts` row of the
 *                      caller's with no calendar event and no human title,
 *                      or a temporary one (migration 042);
 *   kind 'registry'  — a Darth Recorder registry row still on a Mac (not
 *                      uploaded yet, or its upload failed).
 *
 * Sections: 'mac' (registry), 'uploaded' (kept recordings + legacy bare
 * rows), 'temporary' (recordings with an expiry + legacy scratch rows).
 *
 * And one more, asked for BY NAME only (2026-10-02): 'linked' — the caller's
 * standalone recordings that a live meeting holds (a `meeting_clips` row on
 * a meeting not in the trash). Linking used to make a recording vanish from
 * /recordings; this section keeps it findable. It is never part of the
 * default set (no `section`, or the older flags), and `counts.linked` is
 * present only on an answer to `section=linked` — so the default answer is
 * byte-for-byte what darth-cli has always read.
 *
 * Order and cursor: `(sort_us DESC, kind ASC, id DESC)`, where `sort_us` is
 * the item's time (capture start, else creation) in integer MICROSECONDS —
 * a Postgres timestamp's own precision, so the keyset compares exactly (a JS
 * Date would round to ms and duplicate or skip rows at a page boundary).
 */

/** The default set: the recordings that belong to no meeting. */
export const RECORDING_SECTIONS = ['mac', 'uploaded', 'temporary'] as const;
/** Every section a request may name — the default set plus 'linked'. */
export const NAMED_RECORDING_SECTIONS = [...RECORDING_SECTIONS, 'linked'] as const;
export type RecordingSection = (typeof NAMED_RECORDING_SECTIONS)[number];

export const RECORDING_ITEM_KINDS = ['meeting', 'recording', 'registry'] as const;
export type RecordingItemKind = (typeof RECORDING_ITEM_KINDS)[number];

export const RECORDINGS_PAGE_DEFAULT = 50;
export const RECORDINGS_PAGE_MAX = 200;

export interface RecordingsPageCursor {
  /** Microseconds since the epoch, as a decimal string (bigint-safe). */
  sortUs: string;
  kind: RecordingItemKind;
  id: string;
}

export interface RecordingsPageQuery {
  /** Which sections to list (never empty). */
  sections: RecordingSection[];
  /** Title / filename / call-title search; null = none. */
  q: string | null;
  /** `q` is a POSIX regex (case-insensitive), like the listing's `?regex=1`. */
  regex: boolean;
  /** 0 = counts only. */
  limit: number;
  cursor: RecordingsPageCursor | null;
  tz: string;
}

export interface RecordingSectionCounts {
  mac: number;
  uploaded: number;
  temporary: number;
  /** Only on an answer to `section=linked` (absent otherwise — CLI compat). */
  linked?: number;
}

export function encodeRecordingsCursor(c: RecordingsPageCursor): string {
  const raw = JSON.stringify([c.sortUs, c.kind, c.id]);
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeRecordingsCursor(raw: string | null | undefined): RecordingsPageCursor | null {
  if (!raw) return null;
  try {
    const text =
      typeof Buffer !== 'undefined'
        ? Buffer.from(raw, 'base64url').toString('utf8')
        : atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const v = JSON.parse(text) as unknown;
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [sortUs, kind, id] = v as [unknown, unknown, unknown];
    if (typeof sortUs !== 'string' || !/^-?\d{1,19}$/.test(sortUs)) return null;
    if (typeof kind !== 'string' || !(RECORDING_ITEM_KINDS as readonly string[]).includes(kind)) return null;
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
    return { sortUs, kind: kind as RecordingItemKind, id };
  } catch {
    return null;
  }
}

const TZ_RE = /^[A-Za-z0-9_/+-]{1,64}$/;

/**
 * `?mine=1[&section=mac|uploaded|temporary|linked][&unlinked=1][&temporary=1]
 * [&q=][&regex=1][&limit=][&cursor=][&tz=]` → the query, or an error.
 *
 * `section` names ONE section. The older flags still work: `unlinked=1` =
 * mac + uploaded, `temporary=1` = temporary, both or neither = all three
 * (never 'linked', which is only ever asked for by name).
 */
export function parseRecordingsPageQuery(
  params: URLSearchParams
): { ok: true; query: RecordingsPageQuery } | { ok: false; error: string } {
  if (params.get('mine') !== '1') {
    return { ok: false, error: 'Expected ?mine=1 — recordings are listed for their owner only' };
  }
  let sections: RecordingSection[];
  const section = params.get('section');
  if (section) {
    if (!(NAMED_RECORDING_SECTIONS as readonly string[]).includes(section)) {
      return { ok: false, error: 'section must be one of mac, uploaded, temporary, linked' };
    }
    sections = [section as RecordingSection];
  } else {
    const u = params.get('unlinked') === '1';
    const t = params.get('temporary') === '1';
    sections = u && !t ? ['mac', 'uploaded'] : t && !u ? ['temporary'] : [...RECORDING_SECTIONS];
  }

  const rawLimit = params.get('limit');
  let limit = RECORDINGS_PAGE_DEFAULT;
  if (rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 0 || n > RECORDINGS_PAGE_MAX) {
      return { ok: false, error: `limit must be an integer 0..${RECORDINGS_PAGE_MAX}` };
    }
    limit = n;
  }

  const rawCursor = params.get('cursor');
  const cursor = decodeRecordingsCursor(rawCursor);
  if (rawCursor && !cursor) return { ok: false, error: 'Invalid cursor' };

  const q = (params.get('q') ?? '').replace(/\u0000/g, '').trim().slice(0, 200) || null;

  let tz = params.get('tz') ?? 'UTC';
  if (!TZ_RE.test(tz)) tz = 'UTC';
  else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      tz = 'UTC';
    }
  }
  return {
    ok: true,
    query: { sections, q, regex: params.get('regex') === '1' && !!q, limit, cursor, tz },
  };
}

/** `%…%` for ILIKE, with the caller's own `%` / `_` / `\` taken literally. */
export function ilikePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
