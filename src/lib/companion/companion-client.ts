'use client';

import { useEffect, useState } from 'react';

/**
 * Link to the local Darth Recorder menu-bar app (poc/mac-recorder, target darth-tray).
 *
 * The tray serves ws://127.0.0.1:47800. Chrome treats loopback as a potentially
 * trustworthy origin, so this https page may open it without mixed-content
 * complaints. Every message from the tray is a full status snapshot plus a
 * `type` (status | call_started | call_ended | recording_started |
 * recording_stopped) and, for call events, the `call` concerned.
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

export type CompanionEvent =
  | { type: 'call_started' | 'call_ended'; call: CompanionCall; at: number }
  | { type: 'recording_started'; at: number }
  | { type: 'recording_stopped'; at: number; recording?: { path: string; seconds: number; bytes: number } };

export type CompanionState = {
  /** A tray answered at least once during this page's life. */
  connected: boolean;
  version: string | null;
  screenPermission: boolean | null;
  calls: CompanionCall[];
  recording: boolean;
  recordingSince: string | null;
  recordingPath: string | null;
  recordingLabel: string | null;
  lastEvent: CompanionEvent | null;
};

const WS_URL = 'ws://127.0.0.1:47800';
const SEEN_KEY = 'darth-companion-seen';
const MAX_COLD_ATTEMPTS = 5;

const initial: CompanionState = {
  connected: false,
  version: null,
  screenPermission: null,
  calls: [],
  recording: false,
  recordingSince: null,
  recordingPath: null,
  recordingLabel: null,
  lastEvent: null,
};

type Listener = (s: CompanionState) => void;

class CompanionClient {
  state: CompanionState = initial;
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

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

  private ensureStarted() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
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
    };
    ws.onmessage = (e) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      this.applySnapshot(m);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.set({ connected: false, calls: [], recording: false });
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private applySnapshot(m: Record<string, unknown>) {
    const type = String(m.type ?? 'status');
    const at = Date.now();
    let lastEvent: CompanionEvent | null = this.state.lastEvent;
    if (type === 'call_started' || type === 'call_ended') {
      lastEvent = { type, call: m.call as CompanionCall, at };
    } else if (type === 'recording_started') {
      lastEvent = { type, at };
    } else if (type === 'recording_stopped') {
      lastEvent = { type, at, recording: m.recording as CompanionEvent extends { recording?: infer R } ? R : never };
    }
    this.set({
      connected: true,
      version: (m.version as string) ?? null,
      screenPermission: typeof m.screen_recording_permission === 'boolean' ? m.screen_recording_permission : null,
      calls: Array.isArray(m.calls) ? (m.calls as CompanionCall[]) : [],
      recording: Boolean(m.recording),
      recordingSince: (m.recording_since as string) ?? null,
      recordingPath: (m.recording_path as string) ?? null,
      recordingLabel: (m.recording_label as string) ?? null,
      lastEvent,
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

export function callKindLabel(kind: CompanionCall['kind']): string {
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
