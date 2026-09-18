import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { resolveDisplayName } from '@/db-ops/transcript-activity';

export const runtime = 'nodejs';

/**
 * POST /api/offline/outbox — replay of activity a device recorded while it
 * could not reach the server (tech-debt B1; client: src/lib/offline/
 * offline-outbox.ts, worker: public/sw.js 'sync' handler).
 *
 * Body: { events: [{ key, kind: 'view'|'play'|'seek', transcriptId, at, meta? }] }
 *   - at most OUTBOX_BATCH (200) events per call;
 *   - `at` is the ORIGINAL timestamp and is written as-is (clamped to "now"
 *     if a device clock runs ahead; older than MAX_AGE_DAYS → rejected);
 *   - `key` is the idempotency token: an event whose key already exists in
 *     transcript_activity (details.outbox_key) is acknowledged, not
 *     re-inserted — a flush that lost its response is safe to repeat;
 *   - caller-scoped: only meetings the caller owns or is shared on are
 *     written; anything else is `rejected` with reason 'no-access' so the
 *     device drops it (never retried);
 *   - 'view' honours the same 10-minute throttle as the online path,
 *     measured around the offline `at` — a view the server DID log (the
 *     worker served a cached copy but the request had reached the server
 *     first) never double-counts.
 *
 * Answer: { accepted: string[], rejected: [{key, reason}], inserted: number }.
 * `accepted` includes deduped/throttled keys. Content edits are not accepted
 * here by design — offline is read-only.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const OUTBOX_BATCH = 200;
const MAX_AGE_DAYS = 90;
const FUTURE_SLACK_MS = 5 * 60_000;
const VIEW_THROTTLE_MS = 10 * 60_000;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const KEY_MAX = 200;
const KINDS = new Set(['view', 'play', 'seek']);
const META_MAX_ENTRIES = 8;
const META_KEY_MAX = 32;
const META_STR_MAX = 200;

type Kind = 'view' | 'play' | 'seek';

interface OutboxEvent {
  key: string;
  kind: Kind;
  transcriptId: string;
  at: Date;
  meta: Record<string, string | number | boolean> | null;
}

type Rejection = { key: string; reason: string };

function cleanMeta(raw: unknown): OutboxEvent['meta'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= META_MAX_ENTRIES) break;
    if (k.length === 0 || k.length > META_KEY_MAX) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= META_STR_MAX) out[k] = v;
    else continue;
    n += 1;
  }
  return n > 0 ? out : null;
}

/** One raw event → validated OutboxEvent, or the reason it is unusable. */
function parseEvent(
  raw: unknown,
  now: number
): { ok: true; ev: OutboxEvent } | { ok: false; key: string | null; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, key: null, reason: 'malformed' };
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key : null;
  if (!key || key.length === 0 || key.length > KEY_MAX) return { ok: false, key, reason: 'bad-key' };
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) return { ok: false, key, reason: 'bad-kind' };
  if (typeof r.transcriptId !== 'string' || !ID_RE.test(r.transcriptId)) return { ok: false, key, reason: 'bad-id' };
  const t = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
  if (!Number.isFinite(t)) return { ok: false, key, reason: 'bad-at' };
  if (t < now - MAX_AGE_DAYS * 86_400_000) return { ok: false, key, reason: 'too-old' };
  // A clock a few minutes ahead is fine; anything beyond that is clamped.
  const at = new Date(t > now + FUTURE_SLACK_MS ? now : t);
  return { ok: true, ev: { key, kind: r.kind as Kind, transcriptId: r.transcriptId, at, meta: cleanMeta(r.meta) } };
}

export const POST = withAuth(async ({ user, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return NextResponse.json({ error: 'events must be an array' }, { status: 400 });
  if (events.length > OUTBOX_BATCH) {
    return NextResponse.json({ error: `At most ${OUTBOX_BATCH} events per request` }, { status: 400 });
  }

  const now = Date.now();
  const rejected: Rejection[] = [];
  const accepted: string[] = [];
  const valid: OutboxEvent[] = [];
  const seenKeys = new Set<string>();
  for (const raw of events) {
    const p = parseEvent(raw, now);
    if (!p.ok) {
      if (p.key) rejected.push({ key: p.key, reason: p.reason });
      continue;
    }
    if (seenKeys.has(p.ev.key)) continue; // duplicate inside the batch
    seenKeys.add(p.ev.key);
    valid.push(p.ev);
  }
  if (valid.length === 0) return NextResponse.json({ accepted, rejected, inserted: 0 });

  // Caller scope in ONE query (resolveAccess, but for a set): own rows
  // first so the (user_id, assemblyai_id) duplicates resolve like the
  // single-row resolver does.
  const ids = [...new Set(valid.map((e) => e.transcriptId))];
  const email = user.email.trim().toLowerCase();
  const visible = await sql<Array<{ id: number; assemblyai_id: string }>>`
    SELECT t.id, t.assemblyai_id
    FROM ${sql(SCHEMA)}.transcripts t
    LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
      ON s.transcript_id = t.id AND s.shared_with_email = ${email}
    WHERE t.assemblyai_id = ANY(${ids})
      AND (t.user_id = ${user.userId} OR s.id IS NOT NULL)
    ORDER BY (t.user_id = ${user.userId}) DESC
  `;
  const rowIdByAai = new Map<string, number>();
  for (const v of visible) if (!rowIdByAai.has(v.assemblyai_id)) rowIdByAai.set(v.assemblyai_id, v.id);

  const scoped: Array<OutboxEvent & { transcriptRowId: number }> = [];
  for (const ev of valid) {
    const rowId = rowIdByAai.get(ev.transcriptId);
    if (rowId === undefined) rejected.push({ key: ev.key, reason: 'no-access' });
    else scoped.push({ ...ev, transcriptRowId: rowId });
  }
  if (scoped.length === 0) return NextResponse.json({ accepted, rejected, inserted: 0 });

  const rowIds = [...new Set(scoped.map((e) => e.transcriptRowId))];

  // Idempotency: keys this user already replayed.
  const known = await sql<Array<{ k: string }>>`
    SELECT details->>'outbox_key' AS k
    FROM ${sql(SCHEMA)}.transcript_activity
    WHERE user_id = ${user.userId}
      AND transcript_id = ANY(${rowIds})
      AND details ? 'outbox_key'
  `;
  const knownKeys = new Set(known.map((r) => r.k));

  // View throttle: existing views around the offline timestamps.
  const viewEvents = scoped.filter((e) => e.kind === 'view');
  const recentViews = new Map<number, number[]>();
  if (viewEvents.length > 0) {
    const times = viewEvents.map((e) => e.at.getTime());
    const minAt = new Date(Math.min(...times) - VIEW_THROTTLE_MS);
    const maxAt = new Date(Math.max(...times) + VIEW_THROTTLE_MS);
    const viewRowIds = [...new Set(viewEvents.map((e) => e.transcriptRowId))];
    const rows = await sql<Array<{ transcript_id: number; at: string }>>`
      SELECT transcript_id, at
      FROM ${sql(SCHEMA)}.transcript_activity
      WHERE user_id = ${user.userId}
        AND transcript_id = ANY(${viewRowIds})
        AND action = 'view'
        AND at >= ${minAt} AND at <= ${maxAt}
    `;
    for (const r of rows) {
      const list = recentViews.get(r.transcript_id) ?? [];
      list.push(new Date(r.at).getTime());
      recentViews.set(r.transcript_id, list);
    }
  }

  const userName = await resolveDisplayName(user.email);

  let inserted = 0;
  scoped.sort((a, b) => a.at.getTime() - b.at.getTime());
  await sql.begin(async (tx) => {
    for (const ev of scoped) {
      if (knownKeys.has(ev.key)) {
        accepted.push(ev.key);
        continue;
      }
      if (ev.kind === 'view') {
        const t = ev.at.getTime();
        const views = recentViews.get(ev.transcriptRowId) ?? [];
        if (views.some((v) => Math.abs(v - t) < VIEW_THROTTLE_MS)) {
          accepted.push(ev.key); // throttled — the server already has a view nearby
          continue;
        }
        views.push(t);
        recentViews.set(ev.transcriptRowId, views);
      }
      const details = { outbox_key: ev.key, offline: true, ...(ev.meta ?? {}) };
      await tx`
        INSERT INTO ${tx(SCHEMA)}.transcript_activity (
          transcript_id, user_id, user_email, user_name, action, details, at
        ) VALUES (
          ${ev.transcriptRowId},
          ${user.userId},
          ${email},
          ${userName},
          ${ev.kind},
          ${tx.json(details as unknown as never)},
          ${ev.at}
        )
      `;
      inserted += 1;
      accepted.push(ev.key);
    }
  });

  if (inserted > 0) {
    // Offline views count as access like online ones (owner's rows only —
    // same as GET /api/transcripts/:id's touchLastAccessedForUser).
    const viewedIds = [...new Set(scoped.filter((e) => e.kind === 'view').map((e) => e.transcriptId))];
    if (viewedIds.length > 0) {
      try {
        await sql`
          UPDATE ${sql(SCHEMA)}.transcripts
          SET last_accessed = now()
          WHERE user_id = ${user.userId} AND assemblyai_id = ANY(${viewedIds})
        `;
      } catch (err) {
        console.warn('[offline-outbox] last_accessed bump failed', err);
      }
    }
  }

  return NextResponse.json({ accepted, rejected, inserted }, { headers: { 'Cache-Control': 'private, no-store' } });
});
