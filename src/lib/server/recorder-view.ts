import 'server-only';
import type { RecorderRecordingRow, RecordingWrite } from '@/db-ops/recorder';
import { isRecordingStatus } from '@/db-ops/recorder';
import type { RecorderMatch } from '@/lib/recorder';

/**
 * Wire shapes for /api/recorder/recordings — one place so the owner view and
 * the redacted view can never drift.
 *
 * THE RULE (feedback_privacy_caller_scoping_gate): a caller who is merely
 * involved in the occurrence learns that a recording EXISTS, who owns it and
 * what state it is in. Local file paths, segment lists, window titles, share
 * events and error strings are the owner's alone.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OwnRecordingView {
  id: string;
  mine: true;
  device_id: string | null;
  owner_email: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  bytes: number | null;
  segments: unknown;
  call: unknown;
  shares: unknown;
  matched: RecorderMatch | null;
  transcript_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface OthersRecordingView {
  id: string;
  mine: false;
  owner_email: string | null;
  status: string;
  started_at: string | null;
  duration_s: number | null;
  transcript_id: string | null;
  /** Occurrence identity only — no title, no window text. */
  matched: { meeting_code: string | null; occ_start: string; score: number } | null;
  /** When THIS caller last asked the owner to upload it. */
  nudged_at: string | null;
}

export type RecordingView = OwnRecordingView | OthersRecordingView;

export function ownView(r: RecorderRecordingRow): OwnRecordingView {
  return {
    id: r.id,
    mine: true,
    device_id: r.device_id,
    owner_email: r.email,
    status: r.status,
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    duration_s: r.duration_s,
    bytes: r.bytes === null ? null : Number(r.bytes),
    segments: r.segments ?? null,
    call: r.call ?? null,
    shares: r.shares ?? null,
    matched: r.matched ?? null,
    transcript_id: r.transcript_id,
    error: r.error,
    created_at: iso(r.created_at) ?? r.created_at,
    updated_at: iso(r.updated_at) ?? r.updated_at,
  };
}

export function othersView(
  r: RecorderRecordingRow,
  nudgedAt: string | null
): OthersRecordingView {
  return {
    id: r.id,
    mine: false,
    owner_email: r.email,
    status: r.status,
    started_at: iso(r.started_at),
    duration_s: r.duration_s,
    transcript_id: r.transcript_id,
    matched: r.matched
      ? {
          meeting_code: r.matched.meeting_code ?? null,
          occ_start: r.matched.occ_start,
          score: r.matched.score,
        }
      : null,
    nudged_at: nudgedAt,
  };
}

function iso(v: string | Date | null): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type ParseResult =
  | { ok: true; write: RecordingWrite }
  | { ok: false; error: string };

/** Body → RecordingWrite. Only keys actually present survive, so a PATCH
 * carrying `{bytes}` never blanks `call`. */
export function parseRecordingWrite(body: Record<string, unknown>): ParseResult {
  const w: RecordingWrite = {};

  if (body.device_id !== undefined && body.device_id !== null) {
    const v = String(body.device_id).trim();
    if (!UUID_RE.test(v)) return { ok: false, error: 'device_id must be a uuid' };
    w.deviceId = v;
  }
  if (body.status !== undefined && body.status !== null) {
    if (!isRecordingStatus(body.status)) {
      return { ok: false, error: `status must be one of recording|local|uploading|uploaded|upload_failed|deleted` };
    }
    w.status = body.status;
  }
  for (const [key, field] of [
    ['started_at', 'startedAt'],
    ['ended_at', 'endedAt'],
  ] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (Number.isNaN(t)) return { ok: false, error: `${key} must be an ISO timestamp` };
    w[field] = new Date(t).toISOString();
  }
  for (const [key, field] of [
    ['duration_s', 'durationS'],
    ['bytes', 'bytes'],
  ] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: `${key} must be a non-negative number` };
    w[field] = Math.round(n);
  }
  for (const [key, field] of [
    ['segments', 'segments'],
    ['call', 'call'],
    ['shares', 'shares'],
  ] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'object') return { ok: false, error: `${key} must be an object or array` };
    w[field] = raw;
  }
  if (body.error !== undefined) {
    w.error = body.error === null ? null : String(body.error).slice(0, 2000);
  }
  if (typeof body.transcript_id === 'string' && body.transcript_id.trim()) {
    w.transcriptId = body.transcript_id.trim().slice(0, 200);
  }
  return { ok: true, write: w };
}
