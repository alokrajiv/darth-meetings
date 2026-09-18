'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Link to the local Darth Recorder menu-bar app (poc/mac-recorder, target darth-tray).
 *
 * The tray serves ws://127.0.0.1:47800. Chrome treats loopback as a potentially
 * trustworthy origin, so this https page may open it without mixed-content
 * complaints.
 *
 * Wire shape (tray → page). Every message carries a `type`; most also carry a
 * full status snapshot (`version`, `calls`, `recording`, …) — see
 * `statusPayload()` in poc/mac-recorder/Sources/darth-tray/main.swift:
 *
 *   status | call_started | call_ended | recording_started | recording_stopped
 *   0.2.0+: share_started | share_ended | segment_started | upload_progress |
 *           upload_done | upload_failed | auth_changed | recordings
 *
 * Snapshot fields we read (0.1.x): version, screen_recording_permission,
 * calls[], recording (boolean), recording_since, recording_path,
 * recording_label, update_available, update_staged.
 * 0.2.0 additions: signed_in, email, device_id, share {app, kind, target},
 * recordings_pending_upload, auto_upload (optional).
 *
 * `recording_stopped` on 0.1.5 overwrote the boolean `recording` with the
 * saved-file object — which is why `recording` here is derived strictly from
 * `m.recording === true` and the file info is read from `saved` (0.2.0) or from
 * that object (0.1.x). Never trust `Boolean(m.recording)`.
 *
 * Commands (page → tray): {cmd:"start", pid?} {cmd:"stop"} {cmd:"status"}
 * {cmd:"login"} {cmd:"upload", recording_id, linked_event?}
 * {cmd:"list_recordings", req} → answered with {type:"recordings",
 * recordings:[…], req?}. A pre-0.2.0 tray logs "unknown cmd" and never
 * answers; `listRecordings()` times out and rejects with code 'unsupported'
 * so the UI can say "update your recorder" instead of spinning.
 *
 * Reconnect policy: most people have no helper installed, and a failing
 * WebSocket logs a console error on every attempt, so we back off 2s → 60s and
 * give up after a handful of tries — unless this browser has EVER connected
 * (localStorage flag), in which case we keep trying at 30s forever.
 */

export type CompanionCall = {
  id: string;
  pid: number;
  app: string;
  bundle_id: string;
  kind: 'teams' | 'meet' | 'zoom' | 'slack' | 'facetime' | 'whatsapp' | 'webex' | 'discord' | 'browser' | 'other';
  title: string;
  started_at: string;
};

/** Active screen share seen by the tray (0.2.0+). */
export type CompanionShare = {
  app: string;
  kind: 'display' | 'window' | string;
  /** Human target: window title / owner or "Display 2". */
  target: string | null;
};

/** The file info a stop event carries. `recording_id` and `matched` exist on 0.2.0+. */
export type CompanionSaved = {
  path: string | null;
  seconds: number;
  bytes: number;
  call?: CompanionCall | null;
  recording_id?: string | null;
  /** Calendar event the tray/server matched the recording to, if any. */
  matched?: CompanionMatchedEvent | null;
};

/** Loose shape of a matched calendar event; anything with an `id` can be
 * forwarded as `linked_event` on an upload command. */
export type CompanionMatchedEvent = {
  id?: string;
  event_key?: string;
  meeting_code?: string;
  title?: string;
  score?: number;
  [k: string]: unknown;
};

export type CompanionRecordingStatus = 'recording' | 'local' | 'uploading' | 'uploaded' | 'upload_failed' | 'deleted' | string;

/** One entry of the tray's local registry ({cmd:"list_recordings"} answer). */
export type CompanionRecording = {
  id: string;
  files: string[];
  bytes: number;
  /** Seconds. */
  duration: number;
  started_at: string | null;
  call: { kind?: string; title?: string; app?: string } | null;
  status: CompanionRecordingStatus;
  transcript_id: string | null;
  error: string | null;
  matched: CompanionMatchedEvent | null;
};

/** Per-recording upload progress folded from upload_* events (0.2.0+). */
export type CompanionUploadState = {
  status: 'uploading' | 'done' | 'failed';
  pct: number;
  segment: number | null;
  transcriptId: string | null;
  error: string | null;
  at: number;
};

export type CompanionEvent =
  | { type: 'call_started' | 'call_ended'; call: CompanionCall; at: number }
  | { type: 'recording_started'; at: number }
  | { type: 'recording_stopped'; at: number; saved: CompanionSaved | null }
  | { type: 'share_started' | 'share_ended'; share: CompanionShare | null; at: number }
  | { type: 'segment_started'; at: number; segment: number | null }
  | { type: 'upload_progress' | 'upload_done' | 'upload_failed'; at: number; recordingId: string | null }
  | { type: 'auth_changed'; at: number }
  | { type: 'recording_deleted'; at: number; recordingId: string | null; error: string | null }
  | { type: 'auth_prompt'; at: number; verifyUrl: string | null; userCode: string | null; title: string | null };

export type CompanionState = {
  /** A tray answered at least once during this page's life. */
  connected: boolean;
  /** This browser has connected to a tray at some point (localStorage) — i.e. it is installed here. */
  everSeen: boolean;
  version: string | null;
  /** 'legacy' = pre-0.2.0 snapshot (no sign-in / registry fields); 'v2' once any 0.2.0 field shows up. */
  protocol: 'legacy' | 'v2';
  screenPermission: boolean | null;
  calls: CompanionCall[];
  recording: boolean;
  recordingSince: string | null;
  recordingPath: string | null;
  /** The registry id of the recording in progress (0.2.0+ snapshots carry `recording_id`). */
  recordingId: string | null;
  recordingLabel: string | null;
  /** null = the tray does not report it (legacy). */
  signedIn: boolean | null;
  /** The device-flow approval the tray is waiting on (0.2.1+ `auth_prompt`); cleared on auth_changed. */
  authPrompt: { verifyUrl: string | null; userCode: string | null; title: string | null; at: number } | null;
  email: string | null;
  deviceId: string | null;
  share: CompanionShare | null;
  /** null = the tray does not report it (legacy). */
  recordingsPendingUpload: number | null;
  /** The tray answers {cmd:"list_recordings"} — i.e. it is 0.2.0 or newer. */
  supportsRegistry: boolean;
  /** null = the tray does not report it. */
  autoUpload: boolean | null;
  /** Version string of an update the tray has seen / staged, else null. */
  updateAvailable: string | null;
  updateStaged: string | null;
  uploads: Record<string, CompanionUploadState>;
  lastEvent: CompanionEvent | null;
  /** The most recent stop, held separately from `lastEvent`: the saved-recording
   * toast has to survive the upload_* events its own "Upload now" sets off. */
  lastStopped: { at: number; saved: CompanionSaved | null } | null;
};

const WS_URL = 'ws://127.0.0.1:47800';
const LIST_TIMEOUT_MS = 4_000;
/** First tray that speaks the sign-in / registry / share protocol. */
const V2_VERSION = '0.2.0';

/** Numeric-dotted compare, tolerant of junk ("0.2.0-dev" → 0.2.0). */
export function versionAtLeast(v: string | null, min: string): boolean {
  if (!v) return false;
  const a = v.split(/[^0-9]+/).filter(Boolean).map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** The helper exists for macOS only (Windows/Linux planned). Elsewhere we never
 * touch the socket: nothing to connect to, and no console noise for those users.
 * An `everSeen` flag still wins, so a future non-Mac helper works once installed. */
export function companionPlatformSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const p = uaData?.platform ?? navigator.platform ?? '';
  return /mac/i.test(p);
}
const SEEN_KEY = 'darth-companion-seen';
const MAX_COLD_ATTEMPTS = 5;

const initial: CompanionState = {
  connected: false,
  everSeen: false,
  version: null,
  protocol: 'legacy',
  screenPermission: null,
  calls: [],
  recording: false,
  recordingSince: null,
  recordingPath: null,
  recordingId: null,
  recordingLabel: null,
  signedIn: null,
  authPrompt: null,
  email: null,
  deviceId: null,
  share: null,
  recordingsPendingUpload: null,
  supportsRegistry: false,
  autoUpload: null,
  updateAvailable: null,
  updateStaged: null,
  uploads: {},
  lastEvent: null,
  lastStopped: null,
};

export class CompanionError extends Error {
  code: 'unsupported' | 'disconnected';
  constructor(code: 'unsupported' | 'disconnected', message: string) {
    super(message);
    this.name = 'CompanionError';
    this.code = code;
  }
}

type Listener = (s: CompanionState) => void;
type Pending = { req: string; resolve: (r: CompanionRecording[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function parseShare(v: unknown): CompanionShare | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const target = str(o.target) ?? str(o.window_title) ?? str(o.window_owner) ?? (o.display_id != null ? `Display ${String(o.display_id)}` : null);
  return { app: str(o.app) ?? str(o.app_bundle) ?? 'an app', kind: str(o.kind) ?? 'display', target };
}

function parseMatched(v: unknown): CompanionMatchedEvent | null {
  if (!v || typeof v !== 'object') return null;
  return v as CompanionMatchedEvent;
}

function parseSaved(v: unknown): CompanionSaved | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    path: str(o.path),
    seconds: num(o.seconds),
    bytes: num(o.bytes),
    call: (o.call as CompanionCall | null | undefined) ?? null,
    recording_id: str(o.recording_id) ?? str(o.id),
    matched: parseMatched(o.matched ?? o.event ?? o.linked_event),
  };
}

export function parseRecording(v: unknown): CompanionRecording | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id) ?? str(o.recording_id);
  if (!id) return null;
  const files = Array.isArray(o.files)
    ? (o.files as unknown[]).map((f) => (typeof f === 'string' ? f : str((f as Record<string, unknown>)?.path) ?? '')).filter(Boolean)
    : str(o.path)
      ? [str(o.path)!]
      : [];
  const call = o.call && typeof o.call === 'object' ? (o.call as CompanionRecording['call']) : null;
  return {
    id,
    files,
    bytes: num(o.bytes),
    duration: num(o.duration_s, num(o.duration, num(o.seconds))),
    started_at: str(o.started_at),
    call,
    status: str(o.status) ?? 'local',
    transcript_id: str(o.transcript_id),
    error: str(o.error),
    matched: parseMatched(o.matched),
  };
}

class CompanionClient {
  state: CompanionState = initial;
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private pending: Pending[] = [];
  private reqSeq = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    this.ensureStarted();
    return () => {
      this.listeners.delete(fn);
    };
  }

  send(cmd: string, extra: Record<string, unknown> = {}): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ cmd, ...extra }));
    return true;
  }

  /** Start the darth device-flow sign-in in the tray (0.2.0+; older trays ignore it). */
  login(): boolean {
    return this.send('login');
  }

  /** Upload (or retry) a local recording from the tray. `linkedEvent` is the
   * same object the web upload sends (`linkedEvent` on /api/uploads open);
   * the tray forwards it to the one-shot route untouched. */
  upload(recordingId: string, linkedEvent?: unknown | null): boolean {
    const extra: Record<string, unknown> = { recording_id: recordingId };
    if (linkedEvent) extra.linked_event = linkedEvent;
    return this.send('upload', extra);
  }

  /** Delete a recording from the Mac (tray 0.3.8+: files + folder go, the
   * registry row becomes `deleted` and is synced to the server; an uploaded
   * transcript is untouched). The tray answers with `recording_deleted`; an
   * older tray logs "unknown cmd" and the row simply stays. */
  deleteRecording(recordingId: string): boolean {
    return this.send('delete_recording', { recording_id: recordingId });
  }

  /** Flip the tray's "Upload recordings automatically" setting (0.2.0+). The
   * tray confirms by broadcasting a status with the new `auto_upload`. */
  setAutoUpload(enabled: boolean): boolean {
    return this.send('set_auto_upload', { enabled });
  }

  /** Ask the tray for its local registry. Resolves on the next
   * {type:"recordings"} message (matched by `req` when the tray echoes it,
   * otherwise the oldest waiter takes it); rejects 'disconnected' when no
   * tray is on the socket and 'unsupported' when nothing answers within
   * LIST_TIMEOUT_MS — the pre-0.2.0 tray never does. */
  listRecordings(): Promise<CompanionRecording[]> {
    return new Promise<CompanionRecording[]>((resolve, reject) => {
      const req = `r${++this.reqSeq}`;
      if (!this.send('list_recordings', { req })) {
        reject(new CompanionError('disconnected', 'Darth Recorder is not connected'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p.req !== req);
        reject(new CompanionError('unsupported', 'Darth Recorder does not support this yet — update it'));
      }, LIST_TIMEOUT_MS);
      this.pending.push({ req, resolve, reject, timer });
    });
  }

  private settleList(m: Record<string, unknown>) {
    const list = Array.isArray(m.recordings) ? (m.recordings as unknown[]).map(parseRecording).filter((r): r is CompanionRecording => !!r) : [];
    const req = str(m.req);
    let idx = req ? this.pending.findIndex((p) => p.req === req) : 0;
    if (idx < 0) idx = 0;
    const p = this.pending[idx];
    if (!p) return;
    this.pending.splice(idx, 1);
    clearTimeout(p.timer);
    p.resolve(list);
  }

  private failPending(err: CompanionError) {
    for (const p of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending = [];
  }

  private ensureStarted() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (seen) this.set({ everSeen: true });
    if (!seen && !companionPlatformSupported()) return; // Windows/Linux: stay silent
    this.connect();
  }

  /** Manual retry (Settings card "Check again"): reconnect now, reset the cold-start budget. */
  retryNow() {
    if (!companionPlatformSupported() && !this.state.everSeen) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempts = 0;
    this.connect();
  }

  private set(patch: Partial<CompanionState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private connect() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      try {
        localStorage.setItem(SEEN_KEY, '1');
      } catch {
        /* private mode */
      }
      this.set({ everSeen: true });
    };
    ws.onmessage = (e) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      this.applyMessage(m);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.failPending(new CompanionError('disconnected', 'Darth Recorder disconnected'));
      this.set({ connected: false, calls: [], recording: false, share: null });
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private applyMessage(m: Record<string, unknown>) {
    const type = String(m.type ?? 'status');
    const at = Date.now();

    if (type === 'recordings') {
      this.settleList(m);
      // A registry answer may or may not ride on a snapshot; fall through only if it does.
      if (!('version' in m)) return;
    }

    let lastEvent: CompanionEvent | null = this.state.lastEvent;
    let lastStopped = this.state.lastStopped;
    let authPrompt = this.state.authPrompt;
    let uploads = this.state.uploads;
    switch (type) {
      case 'call_started':
      case 'call_ended':
        lastEvent = { type, call: m.call as CompanionCall, at };
        break;
      case 'recording_started':
        lastEvent = { type, at };
        lastStopped = null;
        break;
      case 'recording_stopped': {
        // 0.2.0: `saved`; 0.1.x: the file object sat on `recording` itself.
        const saved = parseSaved(m.saved) ?? (typeof m.recording === 'object' ? parseSaved(m.recording) : null);
        lastEvent = { type, at, saved };
        lastStopped = { at, saved };
        break;
      }
      case 'share_started':
      case 'share_ended':
        lastEvent = { type, share: parseShare(m.share), at };
        break;
      case 'segment_started':
        lastEvent = { type, at, segment: typeof m.segment === 'number' ? m.segment : null };
        break;
      case 'upload_progress':
      case 'upload_done':
      case 'upload_failed': {
        const id = str(m.recording_id);
        if (id) {
          const prev = uploads[id];
          const next: CompanionUploadState =
            type === 'upload_progress'
              ? { status: 'uploading', pct: Math.max(0, Math.min(100, num(m.pct, prev?.pct ?? 0))), segment: typeof m.segment === 'number' ? m.segment : null, transcriptId: null, error: null, at }
              : type === 'upload_done'
                ? { status: 'done', pct: 100, segment: null, transcriptId: str(m.transcript_id), error: null, at }
                : { status: 'failed', pct: prev?.pct ?? 0, segment: null, transcriptId: null, error: str(m.error) ?? 'Upload failed', at };
          uploads = { ...uploads, [id]: next };
        }
        lastEvent = { type, at, recordingId: id };
        break;
      }
      case 'auth_changed':
        lastEvent = { type, at };
        authPrompt = null;
        break;
      case 'recording_deleted':
        // The tray answered a delete_recording (0.3.8): the registry changed, refetch.
        lastEvent = { type, at, recordingId: str(m.recording_id), error: str(m.error) };
        break;
      case 'auth_prompt': {
        const verifyUrl = str(m.verify_url);
        const userCode = str(m.user_code);
        // Only a prompt that carries a URL is an approval to act on; the rest
        // ("timed out", "could not start") are informational and clear it.
        authPrompt = verifyUrl ? { verifyUrl, userCode, title: str(m.title), at } : null;
        lastEvent = { type, at, verifyUrl, userCode, title: str(m.title) };
        break;
      }
      default:
        break;
    }

    // Event-only messages (no snapshot on board) must not blank the snapshot.
    const isSnapshot = 'version' in m || 'calls' in m;
    if (!isSnapshot) {
      this.set({ connected: true, lastEvent, lastStopped, uploads, authPrompt });
      return;
    }

    const version = str(m.version);
    // Two independent signals so neither a field the tray happens to omit nor a
    // hand-edited version string can strand the UI in the wrong mode.
    const v2 = versionAtLeast(version, V2_VERSION) || 'signed_in' in m || 'recordings_pending_upload' in m || 'device_id' in m || 'share' in m;
    const recording = m.recording === true;
    this.set({
      connected: true,
      version,
      protocol: v2 ? 'v2' : 'legacy',
      supportsRegistry: v2,
      screenPermission: typeof m.screen_recording_permission === 'boolean' ? m.screen_recording_permission : null,
      calls: Array.isArray(m.calls) ? (m.calls as CompanionCall[]) : [],
      recording,
      recordingSince: recording ? str(m.recording_since) : null,
      recordingPath: recording ? str(m.recording_path) : null,
      recordingId: recording ? str(m.recording_id) : null,
      recordingLabel: recording ? str(m.recording_label) : null,
      signedIn: typeof m.signed_in === 'boolean' ? m.signed_in : null,
      // A signed-in snapshot ends any pending approval prompt.
      authPrompt: m.signed_in === true ? null : authPrompt,
      email: str(m.email),
      deviceId: str(m.device_id),
      share: parseShare(m.share),
      recordingsPendingUpload: typeof m.recordings_pending_upload === 'number' ? m.recordings_pending_upload : null,
      autoUpload: typeof m.auto_upload === 'boolean' ? m.auto_upload : null,
      updateAvailable: str(m.update_available),
      updateStaged: str(m.update_staged),
      uploads,
      lastEvent,
      lastStopped,
    });
  }

  private scheduleReconnect() {
    if (this.timer) return;
    this.attempts += 1;
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (!seen && this.attempts > MAX_COLD_ATTEMPTS) return; // no helper on this machine; stop spamming the console
    const delay = seen ? 30_000 : Math.min(60_000, 2_000 * 2 ** (this.attempts - 1));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}

let singleton: CompanionClient | null = null;
export function getCompanion(): CompanionClient {
  if (!singleton) singleton = new CompanionClient();
  return singleton;
}

export function useCompanion(): CompanionState {
  const [state, setState] = useState<CompanionState>(initial);
  useEffect(() => getCompanion().subscribe(setState), []);
  return state;
}

export type CompanionRecordingsState = {
  recordings: CompanionRecording[];
  loading: boolean;
  /** 'unsupported' = a tray answered nothing (pre-0.2.0); 'disconnected' = no tray. */
  error: 'unsupported' | 'disconnected' | null;
  refresh: () => void;
};

/** The tray's local registry, refreshed on connect and after every event that
 * can change it (stop, upload progress/done/failed, sign-in). `enabled=false`
 * (a closed dialog) never asks — the old tray would just log an unknown cmd. */
export function useCompanionRecordings(enabled = true): CompanionRecordingsState {
  const c = useCompanion();
  const [recordings, setRecordings] = useState<CompanionRecording[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CompanionRecordingsState['error']>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const ev = c.lastEvent;
  const evKey = ev && REGISTRY_DIRTYING_EVENTS.has(ev.type) ? ev.at : 0;
  const { connected, supportsRegistry, version } = c;

  useEffect(() => {
    if (!enabled) return;
    if (!connected) {
      setLoading(false);
      setError('disconnected');
      setRecordings([]);
      return;
    }
    // A pre-0.2.0 tray silently drops the command, so don't burn the 4 s
    // timeout on every event — the version already told us.
    if (!supportsRegistry) {
      setLoading(false);
      setError('unsupported');
      setRecordings([]);
      return;
    }
    let live = true;
    setLoading(true);
    getCompanion()
      .listRecordings()
      .then((list) => {
        if (!live) return;
        setRecordings(list);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof CompanionError ? e.code : 'unsupported');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, connected, supportsRegistry, version, evKey, nonce]);

  // Fold live upload_* events over the last snapshot so a row moves without
  // waiting for the refetch to land.
  const live = { recording: c.recording, recordingId: c.recordingId };
  const merged = useMemo(
    () =>
      recordings
        // Trays before 0.3.8 list deleted rows too; nothing on the page wants them.
        .filter((r) => r.status !== 'deleted')
        .map((raw) => {
          const r = foldStaleRecording(raw, live);
          const u = c.uploads[r.id];
          if (!u) return r;
          if (u.status === 'uploading') return { ...r, status: 'uploading' as const };
          if (u.status === 'done') return { ...r, status: 'uploaded' as const, transcript_id: r.transcript_id ?? u.transcriptId };
          return { ...r, status: 'upload_failed' as const, error: r.error ?? u.error };
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `live` is rebuilt every render; its two scalars are the real inputs
    [recordings, c.uploads, live.recording, live.recordingId]
  );

  return { recordings: merged, loading, error, refresh };
}

/**
 * A registry row still at `recording` while the tray says nothing is being
 * recorded (or a different id is) belongs to a process that died mid-recording.
 * Trays from 0.3.7 repair such rows at launch; for older trays — and for the
 * window before that launch — the page repairs the VIEW the same way, so the
 * upload picker never shows a disabled spinner that nothing can resolve
 * (3936556e, "Recording now" since 2026-09-16, seen 2026-09-19). Files with
 * bytes → `local` (Upload works: the tray's upload only needs the files);
 * nothing on disk → `upload_failed`.
 */
export function foldStaleRecording(
  r: CompanionRecording,
  live: Pick<CompanionState, 'recording' | 'recordingId'>
): CompanionRecording {
  if (r.status !== 'recording') return r;
  if (live.recording && (live.recordingId == null || live.recordingId === r.id)) return r;
  const hasBytes = r.files.length > 0 && r.bytes > 0;
  return hasBytes
    ? { ...r, status: 'local' }
    : { ...r, status: 'upload_failed', error: r.error ?? 'capture never finished — the recorder was not running when the call ended' };
}

// NOT upload_progress: the tray broadcasts it for every debounced byte-count
// step (≈40 in 3 s on a 150 MB upload — 2026-09-16), and the `merged` fold
// below already moves the row to 'uploading' with the live pct.
const REGISTRY_DIRTYING_EVENTS = new Set([
  'recording_started',
  'recording_stopped',
  'upload_done',
  'upload_failed',
  'auth_changed',
  'recording_deleted',
]);

/** "sharing the PowerPoint window" / "sharing Display 2" — chip + banner copy. */
export function shareLabel(share: CompanionShare | null): string | null {
  if (!share) return null;
  if (share.kind === 'display') return `Sharing ${share.target ?? 'a display'}`;
  return share.target ? `Sharing ${share.target}` : `Sharing a window from ${share.app}`;
}

export function formatCompanionBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatCompanionDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

/** One-line human status for a registry row. */
export function recordingStatusLabel(r: CompanionRecording, upload?: CompanionUploadState): string {
  switch (r.status) {
    case 'recording':
      return 'Recording now';
    case 'uploading':
      return upload && upload.status === 'uploading' ? `Uploading ${Math.round(upload.pct)}%` : 'Uploading…';
    case 'uploaded':
      return 'Uploaded';
    case 'upload_failed':
      return r.error ? `Upload failed — ${r.error}` : 'Upload failed';
    case 'deleted':
      return 'Deleted from this Mac';
    default:
      return 'On this Mac — not uploaded';
  }
}

export function callKindLabel(kind: CompanionCall['kind'] | string | undefined): string {
  switch (kind) {
    case 'teams':
      return 'Teams call';
    case 'meet':
      return 'Google Meet call';
    case 'zoom':
      return 'Zoom call';
    case 'slack':
      return 'Slack huddle';
    case 'facetime':
      return 'FaceTime call';
    case 'whatsapp':
      return 'WhatsApp call';
    case 'webex':
      return 'Webex call';
    case 'discord':
      return 'Discord call';
    case 'browser':
      return 'Browser call';
    default:
      return 'Call';
  }
}
