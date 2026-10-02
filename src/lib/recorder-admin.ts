/**
 * Operator view of the Darth Recorder fleet (darth-admin › Recorder).
 *
 * Pure shaping — no SQL, no I/O — so the derivation rules are unit-testable:
 * db-ops/recorder.ts `listRecorderDevicesForAdmin` + `recordingProgressForAdmin`
 * fetch the rows, `GET /api/admin/recorder/devices` hands them to
 * `buildAdminDevice` below.
 *
 * Inputs per tray:
 *   - `recorder_devices` (`last_status` = the tray's status snapshot, refreshed
 *     by the 5-minute heartbeat),
 *   - a few freshest `recorder_events` (the tray ships them every 60 s): the
 *     last event of any kind, the last `resource_sample`, the last recording
 *     lifecycle event (`recording_started` | `recording_stopped` |
 *     `recording_cancelled`), and the 7-day count of `unclean_exit` + `crash_report`,
 *   - for a tray that is recording: that recording's segment / progress
 *     events and its `recorder_recordings` row (for `call`).
 *
 * PRIVACY: metadata only. Nothing here reads frames, screenshots or file
 * contents; window titles appear only where the tray itself chose to send
 * them (telemetry level `full`).
 */

/** A tray is live when its last event or heartbeat is this recent. Heartbeat = 5 min. */
export const LIVE_WINDOW_MS = 6 * 60_000;
/** A resource sample this recent may override the heartbeat's call / resources. */
export const FRESH_SAMPLE_MS = 3 * 60_000;

export type TrayState = 'recording' | 'in_call' | 'idle' | 'offline';

export interface AdminDeviceInput {
  device_id: string;
  user_id: string;
  email: string | null;
  hostname: string | null;
  os: string | null;
  app_version: string | null;
  first_seen: string | Date;
  last_seen: string | Date;
  last_status: Record<string, unknown> | null;
  last_event_at: string | Date | null;
  resource_ts: string | Date | null;
  resource_payload: Record<string, unknown> | null;
  life_kind: string | null;
  life_ts: string | Date | null;
  life_payload: Record<string, unknown> | null;
  unclean_exits_7d: number | string | null;
}

/** Aggregated progress events for one in-flight recording (recordingProgressForAdmin). */
export interface RecordingProgressInput {
  device_id: string;
  recording_id: string;
  max_segment: number | null;
  closed_segments: number | string | null;
  closed_bytes: number | string | null;
  last_progress_at: string | Date | null;
  latest_source: Record<string, unknown> | null;
  call: Record<string, unknown> | null;
  row_started_at: string | Date | null;
}

export interface RecentRecordingInput {
  id: string;
  device_id: string | null;
  started_at: string | Date | null;
  duration_s: number | null;
  bytes: number | string | null;
  status: string;
  transcript_id: string | null;
  recording_id: string | null;
  error: string | null;
  call_app: string | null;
}

export interface AdminSource {
  kind: string;
  title?: string;
  display_id?: number;
  window_id?: number;
}

export interface AdminCall {
  app: string | null;
  kind: string | null;
  title?: string;
}

export interface AdminRecording {
  recording_id: string;
  started_at: string | null;
  source: AdminSource | null;
  /** Parts so far (the tray rolls a new part on a source flip). */
  segments: number;
  /** Bytes of CLOSED parts; the open part is measured only when it closes. */
  bytes: number;
  /** Elapsed since started_at, at server_time. */
  seconds: number | null;
  /** The newest event that names this recording (resource samples ride on it every ~60 s). */
  last_progress_at: string | null;
  call: AdminCall | null;
  /** Where the answer came from: the heartbeat snapshot, or newer events. */
  from: 'heartbeat' | 'events';
}

export interface AdminRecentRecording {
  id: string;
  started_at: string | null;
  duration_s: number | null;
  bytes: number | null;
  status: string;
  transcript_id: string | null;
  recording_id: string | null;
  error: string | null;
  call_app: string | null;
}

export interface AdminResources {
  ts: string | null;
  cpu_pct: number | null;
  mem_pressure: string | null;
  thermal: string | null;
  battery_pct: number | null;
  battery_state: string | null;
  low_power: boolean | null;
}

export interface AdminDevice {
  device_id: string;
  email: string | null;
  user_id: string;
  hostname: string | null;
  os: string | null;
  app_version: string | null;
  outdated: boolean;
  first_seen: string;
  last_seen: string;
  last_event_at: string | null;
  live: boolean;
  state: TrayState;
  recording: AdminRecording | null;
  calls: unknown[];
  share: unknown;
  upload: unknown;
  pending_uploads: number | null;
  local_disk: unknown;
  telemetry_level: string | null;
  resources: AdminResources | null;
  hardware: { chip: string | null; ram_gb: number | null; hw_model: string | null } | null;
  screen_recording_permission: boolean | null;
  signed_in: boolean | null;
  update_staged: string | null;
  unclean_exits_7d: number;
  recent_recordings: AdminRecentRecording[];
}

// ---------------------------------------------------------------------------

function iso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function ms(v: string | Date | null | undefined): number | null {
  const s = iso(v);
  return s ? Date.parse(s) : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function n(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function b(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** `0.3.21` vs `0.3.9` numerically; non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isOutdated(version: string | null, latest: string | null): boolean {
  return !!version && !!latest && compareVersions(version, latest) < 0;
}

export function shapeSource(v: unknown): AdminSource | null {
  const o = obj(v);
  const kind = o && s(o.kind);
  if (!o || !kind) return null;
  const out: AdminSource = { kind };
  const title = s(o.title);
  if (title) out.title = title;
  const display = n(o.display_id);
  if (display !== null) out.display_id = display;
  const win = n(o.window_id);
  if (win !== null) out.window_id = win;
  return out;
}

function shapeCall(v: unknown): AdminCall | null {
  const o = obj(v);
  if (!o) return null;
  const out: AdminCall = { app: s(o.app), kind: s(o.kind) };
  const title = s(o.title);
  if (title) out.title = title;
  return out.app || out.kind ? out : null;
}

/**
 * The recording a tray is on right now, or null — WHICH id and since when.
 *
 * Two sources, the newer wins (both stamped by the tray's own clock, so they
 * compare): the heartbeat snapshot (`recording`, `recording_id`,
 * `recording_since`, `source`) and the newest lifecycle event.
 *   - a `recording_stopped` / `recording_cancelled` newer than the snapshot
 *     ends the snapshot's recording (it stopped between heartbeats);
 *   - a `recording_started` newer than the snapshot is a recording the
 *     heartbeat has not seen yet;
 *   - otherwise the snapshot decides: `recording:false` → null.
 * An offline tray is never "recording" (its last word may be days old).
 */
export function currentRecordingRef(
  d: Pick<AdminDeviceInput, 'last_status' | 'last_seen' | 'life_kind' | 'life_ts' | 'life_payload'>,
  live: boolean
): { recording_id: string; started_at: string | null; source: AdminSource | null; segment: number | null; from: 'heartbeat' | 'events' } | null {
  if (!live) return null;
  const st = d.last_status ?? {};
  const statusMs = ms(s(st.ts)) ?? ms(d.last_seen) ?? 0;
  const lifeMs = ms(d.life_ts);
  const lifeNewer = lifeMs !== null && lifeMs > statusMs;
  const lifeId = s(d.life_payload?.recording_id);

  if (lifeNewer && d.life_kind === 'recording_started' && lifeId) {
    return {
      recording_id: lifeId.toLowerCase(),
      started_at: iso(d.life_ts),
      source: shapeSource(d.life_payload?.source),
      segment: null,
      from: 'events',
    };
  }
  if (st.recording !== true) return null;
  const id = s(st.recording_id);
  if (!id) return null;
  if (
    lifeNewer &&
    (d.life_kind === 'recording_stopped' || d.life_kind === 'recording_cancelled') &&
    (!lifeId || lifeId.toLowerCase() === id.toLowerCase())
  ) {
    return null;
  }
  return {
    recording_id: id.toLowerCase(),
    started_at: iso(s(st.recording_since)),
    source: shapeSource(st.source),
    segment: n(st.segment),
    from: 'heartbeat',
  };
}

export function isLive(d: Pick<AdminDeviceInput, 'last_seen' | 'last_event_at'>, nowMs: number): boolean {
  const newest = Math.max(ms(d.last_seen) ?? 0, ms(d.last_event_at) ?? 0);
  return newest > 0 && nowMs - newest <= LIVE_WINDOW_MS;
}

function shapeResources(
  status: Record<string, unknown>,
  sampleTs: string | Date | null,
  sample: Record<string, unknown> | null
): AdminResources | null {
  // The newest of the heartbeat's `resources` and the last resource_sample event.
  const fromStatus = obj(status.resources);
  const statusMs = ms(s(fromStatus?.ts)) ?? 0;
  const sampleMs = ms(sampleTs) ?? 0;
  const r = sample && sampleMs > statusMs ? sample : fromStatus;
  if (!r) return null;
  return {
    ts: iso(s(r.ts)) ?? (r === sample ? iso(sampleTs) : null),
    cpu_pct: n(r.cpu_pct),
    mem_pressure: s(r.mem_pressure),
    thermal: s(r.thermal),
    battery_pct: n(r.battery_pct),
    battery_state: s(r.battery_state),
    low_power: b(r.low_power),
  };
}

function shapeRecent(r: RecentRecordingInput): AdminRecentRecording {
  return {
    id: r.id,
    started_at: iso(r.started_at),
    duration_s: n(r.duration_s),
    bytes: n(r.bytes),
    status: r.status,
    transcript_id: r.transcript_id,
    recording_id: r.recording_id,
    error: r.error,
    call_app: r.call_app,
  };
}

/** One `devices[]` entry of GET /api/admin/recorder/devices. */
export function buildAdminDevice(
  d: AdminDeviceInput,
  ctx: {
    nowMs: number;
    latestVersion: string | null;
    progress?: RecordingProgressInput | null;
    recent?: RecentRecordingInput[];
  }
): AdminDevice {
  const st = d.last_status ?? {};
  const live = isLive(d, ctx.nowMs);
  const version = d.app_version ?? s(st.version);
  const calls = Array.isArray(st.calls) ? st.calls : [];

  let recording: AdminRecording | null = null;
  const ref = currentRecordingRef(d, live);
  if (ref) {
    const p = ctx.progress && ctx.progress.recording_id.toLowerCase() === ref.recording_id ? ctx.progress : null;
    const startedAt = ref.started_at ?? iso(p?.row_started_at ?? null);
    const startedMs = ms(startedAt);
    const closed = n(p?.closed_segments) ?? 0;
    const segments = Math.max(1, ref.segment ?? 0, n(p?.max_segment) ?? 0, closed);
    const call =
      shapeCall(p?.call) ??
      (calls.length > 0 ? shapeCall(calls[0]) : null);
    recording = {
      recording_id: ref.recording_id,
      started_at: startedAt,
      source: shapeSource(p?.latest_source) ?? ref.source,
      segments,
      bytes: n(p?.closed_bytes) ?? 0,
      seconds: startedMs !== null ? Math.max(0, Math.round((ctx.nowMs - startedMs) / 1000)) : null,
      last_progress_at: iso(p?.last_progress_at ?? null) ?? ref.started_at,
      call,
      from: ref.from,
    };
  }

  // A fresh resource sample names the live call even between heartbeats.
  const sampleMs = ms(d.resource_ts);
  const freshSampleCall =
    sampleMs !== null && ctx.nowMs - sampleMs <= FRESH_SAMPLE_MS ? s(d.resource_payload?.call_app) : null;

  const state: TrayState = !live
    ? 'offline'
    : recording
      ? 'recording'
      : calls.length > 0 || freshSampleCall
        ? 'in_call'
        : 'idle';

  const hw = obj(st.hardware);
  return {
    device_id: d.device_id,
    email: d.email,
    user_id: d.user_id,
    hostname: d.hostname,
    os: d.os,
    app_version: version,
    outdated: isOutdated(version, ctx.latestVersion),
    first_seen: iso(d.first_seen) ?? '',
    last_seen: iso(d.last_seen) ?? '',
    last_event_at: iso(d.last_event_at),
    live,
    state,
    recording,
    calls:
      calls.length === 0 && freshSampleCall && live ? [{ app: freshSampleCall, from: 'resource_sample' }] : calls,
    share: st.share ?? null,
    upload: st.upload ?? null,
    pending_uploads: n(st.recordings_pending_upload),
    local_disk: st.local_disk ?? null,
    telemetry_level: s(st.telemetry_level),
    resources: shapeResources(st, d.resource_ts, d.resource_payload),
    hardware: hw ? { chip: s(hw.chip), ram_gb: n(hw.ram_gb), hw_model: s(hw.hw_model) } : null,
    screen_recording_permission: b(st.screen_recording_permission),
    signed_in: b(st.signed_in),
    update_staged: s(st.update_staged),
    unclean_exits_7d: n(d.unclean_exits_7d) ?? 0,
    recent_recordings: (ctx.recent ?? []).map(shapeRecent),
  };
}

/** Kinds the events endpoint leaves out unless asked for by name: they are the 60 s samplers. */
export const NOISY_EVENT_KINDS = ['resource_sample', 'process_sample'] as const;

/** `kinds=a,b` → a clean list (≤ 30 names of [a-z0-9_.:-]); null when absent/empty. */
export function parseKinds(raw: string | null): string[] | null {
  if (!raw) return null;
  const out = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => /^[A-Za-z0-9_.:-]{1,64}$/.test(k));
  return out.length > 0 ? Array.from(new Set(out)).slice(0, 30) : null;
}
