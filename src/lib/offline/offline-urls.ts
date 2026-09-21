import { RSC_CACHE_SUFFIX, type PinLevel, type PlanMeeting } from './offline-types';

/**
 * Pure URL arithmetic for offline pins: which same-origin URLs make up a
 * meeting at a given pin level, and how to mine a document / a markdown
 * body for the extra URLs (static chunks, video frames) it depends on.
 *
 * No DOM, no fetch — these are exercised by src/lib/__tests__/offline-urls.test.ts
 * and shared by the sync engine and the service worker helpers.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `via=app` HERE (DEC-3 Stage B, 2026-09-22)
 *
 * Stage B redirects `/api/transcripts/:id/audio` to a cross-origin SAS, and a
 * pin download must NOT be redirected: `cache.put` cannot store an opaque
 * cross-origin body, and an offline copy has to be same-origin anyway. The
 * blob spec's first sketch said this file would append `?via=app` to every
 * media URL it emits. It must not, and the reason is these URLs ARE CACHE
 * KEYS:
 *
 *   - public/sw.js `media()` matches on `url.pathname + url.search`, exactly;
 *   - offline-pins.ts stores, counts (`cachedMediaBytes`) and evicts
 *     (`urlsToDrop` → `cacheDeleteAll`) by that same string;
 *   - components/audio-player.tsx spells `?variant=audio` the same way on
 *     purpose so a pinned extract answers the player from cache.
 *
 * Adding a parameter would therefore (a) orphan every media body already in
 * CACHE_MEDIA — they would be re-downloaded, hundreds of MB per pinned
 * meeting, on a link the user chose because it is expensive — and (b) break
 * OFFLINE PLAYBACK outright for those pins, because the element still asks
 * for the un-suffixed URL and the worker would miss.
 *
 * So the pin downloader marks itself with a REQUEST HEADER instead
 * (`x-darth-media-via: app`, see lib/server/media-serve.ts and the fetches in
 * offline-pins.ts). Headers are invisible to every cache key in this stack, so
 * nothing moves: the same URLs, the same worker matching, the same plan `rev`
 * (which hashes clip/media identity — see lib/server/recordings.ts — and never
 * the URL shape), and not one byte re-downloaded. `?via=app` still works as an
 * explicit opt-out for anyone who wants it in a URL; it is simply not what a
 * pin uses.
 */

const LEVEL_RANK: Record<PinLevel, number> = { none: 0, transcript: 1, audio: 2, video: 3 };

export function levelRank(level: PinLevel): number {
  return LEVEL_RANK[level] ?? 0;
}

/** true when `level` includes everything `wanted` needs (the ladder). */
export function levelIncludes(level: PinLevel, wanted: PinLevel): boolean {
  return levelRank(level) >= levelRank(wanted);
}

export function maxLevel(a: PinLevel, b: PinLevel): PinLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}

/** API sub-resources the transcript page reads. Cached at transcript level. */
export const TRANSCRIPT_API_SUFFIXES = [
  '',
  '/content',
  '/speakers',
  '/edits',
  '/shares',
  '/series',
  '/labels',
  '/ai-runs',
  '/attachments',
  '/activity?limit=200',
] as const;

export interface UrlSet {
  /** Documents (HTML) → pages cache. */
  pages: string[];
  /** JSON + frame jpgs → api cache. */
  api: string[];
  /** Full-body audio/video → media cache. */
  media: string[];
  /** Flight payloads (one per document, key = `<pathname>?__rsc=1`) → api cache. */
  rsc: string[];
}

/** Cache key of a document's flight payload (mirrors RSC_SUFFIX in public/sw.js). */
export function rscCacheKey(pathname: string): string {
  return `${pathname}${RSC_CACHE_SUFFIX}`;
}

/** Minimal shape urlsForLevel needs — a PlanMeeting satisfies it. */
export type UrlMeta = Pick<PlanMeeting, 'media'> | { media?: PlanMeeting['media'] | null } | null | undefined;

export function transcriptPagePath(id: string): string {
  return `/transcript/${encodeURIComponent(id)}`;
}

export function transcriptApiBase(id: string): string {
  return `/api/transcripts/${encodeURIComponent(id)}`;
}

/** Number of recording parts (1 = primary only). Unknown meta → 1. */
export function partCount(meta: UrlMeta): number {
  const parts = meta?.media?.parts;
  if (!parts || parts.length === 0) return meta?.media?.hasLocal === false ? 0 : 1;
  return Math.max(1, parts.length);
}

/**
 * The REAL `?part=N` numbers of a meeting, ascending, primary (1) included.
 *
 * Part numbers are positional and **sparse**: `lib/server/recordings.ts`
 * numbers every file of the recording and then drops the ones whose bytes are
 * not on the VM, so a Meet meeting whose middle segment never landed resolves
 * to parts `[1, 3]` — number 2 stays reserved for the file that is still
 * coming. Until 2026-09-22 this file counted them instead (`partCount`) and
 * emitted `?part=2…n`, which for `[1, 3]` pinned `?part=2` (a 404 that failed
 * the whole pin) and never fetched `?part=3` at all.
 *
 * Unknown meta → `[1]`; a meeting with no stored recording → `[]`.
 */
export function partNumbers(meta: UrlMeta): number[] {
  const parts = meta?.media?.parts;
  if (!parts || parts.length === 0) return meta?.media?.hasLocal === false ? [] : [1];
  const out = new Set<number>();
  for (const p of parts) {
    if (Number.isInteger(p.part) && p.part >= 1) out.add(p.part);
  }
  if (out.size === 0) return [1];
  return [...out].sort((a, b) => a - b);
}

/**
 * The numbers the PRE-2026-09-22 code would have emitted for the same meeting
 * (`2 … parts.length`). Only `urlsToDrop` uses this: an eviction has to remove
 * anything a pin made by the old code could have left behind, even though the
 * new code would never ask for it.
 */
function legacyPartNumbers(meta: UrlMeta): number[] {
  const n = partCount(meta);
  const out: number[] = [];
  for (let part = 1; part <= n; part++) out.push(part);
  return out;
}

/**
 * The exact cache keys for a meeting at `level` (cumulative down the
 * ladder). `markdowns` are the auto_notes / auto_report bodies whose frame
 * images belong to the transcript tier. Keys are path+query, no origin.
 */
export function urlsForLevel(
  id: string,
  level: PinLevel,
  meta?: UrlMeta,
  markdowns: Array<string | null | undefined> = [],
  /** Internal: the part numbers to emit. Only `urlsToDrop` overrides them. */
  parts: number[] = partNumbers(meta)
): UrlSet {
  const out: UrlSet = { pages: [], api: [], media: [], rsc: [] };
  if (levelRank(level) < LEVEL_RANK.transcript) return out;

  out.pages.push(transcriptPagePath(id));
  out.rsc.push(rscCacheKey(transcriptPagePath(id)));
  const base = transcriptApiBase(id);
  for (const suffix of TRANSCRIPT_API_SUFFIXES) out.api.push(base + suffix);
  const frames = new Set<string>();
  for (const md of markdowns) for (const u of extractFrameUrls(md ?? '', id)) frames.add(u);
  out.api.push(...frames);

  if (parts.length === 0) return out;
  // Part 1 is the plain URL (`local_audio_path`); 2… carry `?part=N`. A
  // meeting that somehow has no part 1 still pins the rest by number.
  const extra = parts.filter((p) => p >= 2);
  const hasPrimary = parts.includes(1);

  if (levelRank(level) >= LEVEL_RANK.audio) {
    if (hasPrimary) out.media.push(`${base}/audio?variant=audio`);
    for (const part of extra) out.media.push(`${base}/audio?variant=audio&part=${part}`);
  }
  if (levelRank(level) >= LEVEL_RANK.video) {
    if (hasPrimary) out.media.push(`${base}/audio`);
    for (const part of extra) out.media.push(`${base}/audio?part=${part}`);
  }
  return out;
}

/**
 * URLs present at `from` but not at `to` — what a downgrade must evict.
 *
 * BOTH sides are computed over the real part numbers UNION the positional ones
 * the pre-2026-09-22 code used, so a level change evicts exactly the tiers it
 * removes — including whatever an old pin left under a number this meeting
 * does not have — and never a byte of a tier the pin keeps. Going to `none`
 * (unpin) therefore clears both numberings, and a video→audio downgrade
 * touches only the video tier.
 */
export function urlsToDrop(id: string, from: PinLevel, to: PinLevel, meta?: UrlMeta, markdowns: Array<string | null | undefined> = []): UrlSet {
  const real = partNumbers(meta);
  const wide = [...new Set([...real, ...(real.length > 0 ? legacyPartNumbers(meta) : [])])].sort(
    (x, y) => x - y
  );
  const a = urlsForLevel(id, from, meta, markdowns, wide);
  const b = urlsForLevel(id, to, meta, markdowns, wide);
  const diff = (x: string[], y: string[]) => x.filter((u) => !y.includes(u));
  return { pages: diff(a.pages, b.pages), api: diff(a.api, b.api), media: diff(a.media, b.media), rsc: diff(a.rsc, b.rsc) };
}

/**
 * Frame images a summary/report embeds: `/api/transcripts/<id>/frames/<ms>.jpg`
 * (auto-notes.ts emits exactly that form). Only this meeting's frames count —
 * a body that quotes another meeting's frame must not pull it into the pin.
 */
export function extractFrameUrls(markdown: string, id: string): string[] {
  if (!markdown) return [];
  const re = /\/api\/transcripts\/([^/\s)'"<>]+)\/frames\/(\d+)\.jpg/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    let owner = m[1]!;
    try {
      owner = decodeURIComponent(owner);
    } catch {
      /* keep raw */
    }
    if (owner !== id) continue;
    out.add(`${transcriptApiBase(id)}/frames/${m[2]}.jpg`);
  }
  return [...out];
}

/**
 * Every `/_next/static/...` asset a document depends on: <script src>,
 * <link href>, and quoted paths inside inline scripts (Next's flight payload
 * lists page chunks as "static/chunks/..." strings, JSON-escaped, so the
 * scan stops at quotes, whitespace and backslashes). Returned as absolute
 * paths, de-duplicated, in first-seen order. Query strings are kept (Next
 * versions some assets with ?v=...).
 */
export function extractStaticAssets(html: string): string[] {
  if (!html) return [];
  const out = new Set<string>();
  const add = (raw: string) => {
    let path = raw.replace(/&amp;/g, '&');
    if (!path.startsWith('/')) path = `/_next/${path}`;
    if (!path.startsWith('/_next/static/')) return;
    // Anchors never reach the server; leave query strings alone.
    const hash = path.indexOf('#');
    if (hash >= 0) path = path.slice(0, hash);
    if (path.length > '/_next/static/'.length) out.add(path);
  };

  // Attribute form: src="/_next/static/..." href='/_next/static/...'
  const attr = /\b(?:src|href)\s*=\s*["']([^"']*\/_next\/static\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = attr.exec(html)) !== null) {
    const v = m[1]!;
    const i = v.indexOf('/_next/static/');
    add(v.slice(i));
  }
  // Absolute paths quoted anywhere (inline scripts, preload hints).
  const abs = /\/_next\/static\/[^"'\s\\<>)]+/g;
  while ((m = abs.exec(html)) !== null) add(m[0]);
  // Flight-payload relative form: "static/chunks/…", "static/css/…", "static/media/…".
  const rel = /["'](static\/(?:chunks|css|media)\/[^"'\s\\<>)]+)["'\\]/g;
  while ((m = rel.exec(html)) !== null) add(m[1]!);
  return [...out];
}

/** Bytes the pin dialog quotes before anything is downloaded. */
export function estimatePinBytes(
  level: PinLevel,
  meeting: { durationSec: number | null; media?: PlanMeeting['media'] | null },
  constants: { transcript: number; audioPerSec: number }
): number {
  if (level === 'none') return 0;
  let total = constants.transcript;
  if (levelRank(level) >= LEVEL_RANK.audio) {
    total += Math.max(0, meeting.durationSec ?? 0) * constants.audioPerSec;
  }
  if (levelRank(level) >= LEVEL_RANK.video) {
    total += (meeting.media?.parts ?? []).reduce((s, p) => s + (p.bytes ?? 0), 0);
  }
  return total;
}
