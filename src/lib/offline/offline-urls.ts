import type { PinLevel, PlanMeeting } from './offline-types';

/**
 * Pure URL arithmetic for offline pins: which same-origin URLs make up a
 * meeting at a given pin level, and how to mine a document / a markdown
 * body for the extra URLs (static chunks, video frames) it depends on.
 *
 * No DOM, no fetch — these are exercised by src/lib/__tests__/offline-urls.test.ts
 * and shared by the sync engine and the service worker helpers.
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
] as const;

export interface UrlSet {
  /** Documents (HTML) → pages cache. */
  pages: string[];
  /** JSON + frame jpgs → api cache. */
  api: string[];
  /** Full-body audio/video → media cache. */
  media: string[];
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
 * The exact cache keys for a meeting at `level` (cumulative down the
 * ladder). `markdowns` are the auto_notes / auto_report bodies whose frame
 * images belong to the transcript tier. Keys are path+query, no origin.
 */
export function urlsForLevel(id: string, level: PinLevel, meta?: UrlMeta, markdowns: Array<string | null | undefined> = []): UrlSet {
  const out: UrlSet = { pages: [], api: [], media: [] };
  if (levelRank(level) < LEVEL_RANK.transcript) return out;

  out.pages.push(transcriptPagePath(id));
  const base = transcriptApiBase(id);
  for (const suffix of TRANSCRIPT_API_SUFFIXES) out.api.push(base + suffix);
  const frames = new Set<string>();
  for (const md of markdowns) for (const u of extractFrameUrls(md ?? '', id)) frames.add(u);
  out.api.push(...frames);

  const n = partCount(meta);
  if (n === 0) return out;

  if (levelRank(level) >= LEVEL_RANK.audio) {
    out.media.push(`${base}/audio?variant=audio`);
    for (let part = 2; part <= n; part++) out.media.push(`${base}/audio?variant=audio&part=${part}`);
  }
  if (levelRank(level) >= LEVEL_RANK.video) {
    out.media.push(`${base}/audio`);
    for (let part = 2; part <= n; part++) out.media.push(`${base}/audio?part=${part}`);
  }
  return out;
}

/** URLs present at `from` but not at `to` — what a downgrade must evict. */
export function urlsToDrop(id: string, from: PinLevel, to: PinLevel, meta?: UrlMeta, markdowns: Array<string | null | undefined> = []): UrlSet {
  const a = urlsForLevel(id, from, meta, markdowns);
  const b = urlsForLevel(id, to, meta, markdowns);
  const diff = (x: string[], y: string[]) => x.filter((u) => !y.includes(u));
  return { pages: diff(a.pages, b.pages), api: diff(a.api, b.api), media: diff(a.media, b.media) };
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
