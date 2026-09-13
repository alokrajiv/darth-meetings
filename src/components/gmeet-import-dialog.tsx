'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  getGoogleAccessToken,
  hasValidGoogleToken,
  invalidateGoogleToken,
  switchGoogleAccount,
  connectGoogle,
  GoogleNotConnectedError,
} from '@/lib/google-token';
import {
  AlertCircle,
  BellOff,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  History,
  Link2,
  Loader2,
  RefreshCw,
  Upload,
  Video,
} from 'lucide-react';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';
import { requestMediaUpload } from '@/components/audio-upload';
import { ConnectMicrosoftHint, TeamsChatVerdictLine } from '@/components/calendar-meeting-rows';
import { msLinkMissing, useMsLinkStatus } from '@/components/connect-nudge-banner';
import { asTeamsChatVerdict, teamsChatVerdictCopy, type TeamsChatVerdict } from '@/lib/format';
import { OFFLINE_TITLE, useOfflineGate } from '@/lib/offline/offline-context';
import { isNetworkFailure, offlineAwareError } from '@/lib/offline/offline-fetch';
import type {
  CachedMeetingMeta,
  DiscoverWindowResponse,
  DiscoveredEvent,
  DiscoveredRow,
  EvidenceRequest,
  EvidenceResponse,
  MeetRecordsResponse,
} from '@/lib/meeting-discovery-types';

// Thin client over the meeting-discovery service (Phase 2 of
// docs/meeting-evidence-consolidation.md). Every Google read — calendar day
// / sync window, Meet record listings, per-occurrence artifact evidence —
// goes through /api/calendar/discover, /api/meet/records and
// /api/meet/evidence, which run under the caller's own server-minted token
// and WRITE BACK to the shared caches, so a visit here feeds the listing and
// the poller. The browser token is still used for the import call itself.

type CalendarEvent = DiscoveredEvent;
type EventRow = DiscoveredRow;

/** Thrown by the discovery routes when the caller hasn't connected Google
 * (404) — the dialog shows its Connect pitch. */
class NotConnectedError extends Error {
  constructor() {
    super('Google account not connected yet — hit Connect Google (one time).');
    this.name = 'NotConnectedError';
  }
}

async function discoveryGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.status === 404) throw new NotConnectedError();
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  // The service worker's offline 503 reads "Not available offline", not "offline".
  if (!res.ok) throw await offlineAwareError(res, j.error || `Request failed (${res.status})`);
  return j;
}

/** ISO instants for a local calendar day (the server has no idea what
 * "today" means for this browser). */
function dayWindow(forDate: string): { from: string; to: string } {
  return {
    from: new Date(`${forDate}T00:00:00`).toISOString(),
    to: new Date(`${forDate}T23:59:59.999`).toISOString(),
  };
}

/** Normalised selection — artifacts may come from calendar attachments or a
 * Meet REST API conferenceRecords lookup (`transcriptSource` says which). */
interface PickedMeeting {
  event: CalendarEvent;
  conferenceRecordName: string | null;
  videoFileId: string | null;
  videoName: string | null;
  videoSize: number | null;
  videoDurationMs: number | null;
  videoCount: number;
  transcriptDocId: string | null;
  transcriptSource: 'calendar' | 'meet-api' | 'gemini' | null;
  /** Meet says the artifact exists but is still being processed — no file
   * to import yet, worth re-checking in a few minutes. */
  videoPending: boolean;
  transcriptPending: boolean;
  geminiNotes: boolean;
  /** Poller-cached counts/flags for this occurrence, when we have them. */
  cacheMeta: MeetingMeta | null;
  enriching: boolean;
  /** Row came from the Meet API with no calendar event — its summary is a
   * synthesized label, never a real title. */
  offCalendar: boolean;
}

interface ConflictInfo {
  id: string;
  title: string | null;
  own: boolean;
  /** Who owns the existing import (cross-user conflicts). */
  ownerEmail?: string | null;
  /** False when a colleague imported it but never shared it with you. */
  accessible?: boolean;
}

type Mode = 'video' | 'transcript' | 'both';
type Step =
  | 'connect'
  | 'pick'
  | 'options'
  | 'teams-options'
  | 'teams-external'
  | 'importing'
  | 'done'
  | 'bulk';
type SourceTab = 'calendar' | 'recent' | 'sync';

const MAX_BULK = 20;

/** Cross-user "someone already imported this" info from /api/gmeet/check. */
interface ImportedMark {
  assemblyaiId: string | null;
  title: string | null;
  ownerEmail: string | null;
  accessible: boolean;
  mine: boolean;
}

/** Poller/probe-cached meeting metadata from /api/gmeet/check and
 * /api/meet/evidence — display-only enrichment (badges, instant options
 * step). Access is still proven through the user's own token at import time. */
type MeetingMeta = CachedMeetingMeta;

interface SyncInfo {
  lastSyncedAt: string | null;
  skips: Set<string>;
}

/** Per-row result from /api/teams/check, keyed by calendar event id. */
interface TeamsCheck {
  external: boolean;
  tenantId?: string;
  /** `teams-<hash>` — mute/reminder key (server-computed from the URL). */
  code?: string;
  imported?: ImportedMark | null;
  meta?: {
    hasTranscript: boolean;
    hasRecording: boolean;
    utteranceCount: number | null;
    wordCount: number | null;
    speakers: string[] | null;
    videoDurationMs: number | null;
    confStart: string | null;
    confEnd: string | null;
  } | null;
  /** Teams chat evidence (held / recorded) from the cache row or a live
   * Check again — for rows with no importable artifacts, own-tenant AND
   * external (lib/format TeamsChatVerdict). */
  chat?: TeamsChatVerdict | null;
}

function relDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

interface BulkResult {
  rowId: string;
  title: string;
  status: 'ok' | 'exists' | 'error';
  transcriptId?: string;
  detail?: string;
}

interface GmeetImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful import so the parent can refresh the list. */
  onImported?: () => void;
  /** Open straight into the "Sync" tab (the last-sync nudge on the archive). */
  startInSync?: boolean;
  /** Open on this meeting's calendar day, scrolled to + highlighting it
   *  (reminder-row click). Takes precedence over startInSync. */
  focusMeeting?: { meetingCode: string | null; eventStart: string | null } | null;
}

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO timestamp → local yyyy-mm-dd (the calendar-day picker's format). */
function isoToLocalDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtEventTime(e: CalendarEvent): string {
  const iso = e.start?.dateTime;
  if (!iso) return 'all day';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDayTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function fmtEventRange(e: CalendarEvent): string {
  const s = e.start?.dateTime;
  const en = e.end?.dateTime;
  if (!s) return 'all day';
  const sd = new Date(s);
  const day = sd.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const t1 = sd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const t2 = en
    ? new Date(en).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  return `${day}, ${t1}${t2 ? `–${t2}` : ''}`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function inviteeSummary(e: CalendarEvent): string {
  const all = (e.attendees ?? []).filter(
    (a) => a.email && !a.email.endsWith('.calendar.google.com')
  );
  const names = all.map((a) => a.displayName || a.email!.split('@')[0]);
  const shown = names.slice(0, 8);
  const more = names.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` +${more} more` : '');
}

/** Extract an abc-defg-hij meeting code from a pasted link or bare code. */
function parseMeetCode(input: string): string | null {
  const m = /([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(input.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** 5400000 → "1 h 30 m"; 240000 → "4 min". */
function fmtDurationMs(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} h ${m} m` : `${h} h`;
}

/**
 * "Import from Meet": connect Google → pick a meeting (from the calendar day
 * view, the last-30-days Meet history, or a pasted Meet link) → the options
 * step enriches it (Drive metadata + Meet API artifacts) → choose how to
 * import → run. All Google reads go through the server-side discovery
 * service (caller's own token, written back to the shared caches); the
 * browser token is only used for the import call.
 */
export function GmeetImportDialog({
  open,
  onClose,
  onImported,
  startInSync,
  focusMeeting,
}: GmeetImportDialogProps) {
  const [step, setStep] = useState<Step>('connect');
  /** The connect step shows a SPINNER by default — the Connect pitch renders
   * only after we have positively confirmed the user is not connected (or a
   * load failed with a dead token). Anything else flashes the pitch at every
   * connected user for however long the first calendar load takes. */
  const [connectPitch, setConnectPitch] = useState(false);
  const [tab, setTab] = useState<SourceTab>('calendar');
  const [error, setError] = useState<string | null>(null);
  // Offline mode / network down: nothing in this dialog can reach Google or
  // the server — banner + disabled <fieldset>s around the bodies (Cancel /
  // Done / Back stay outside them).
  const { blocked } = useOfflineGate();
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState<string>(todayLocalISO());
  const [rows, setRows] = useState<EventRow[]>([]);
  const [paste, setPaste] = useState('');
  const [picked, setPicked] = useState<PickedMeeting | null>(null);
  const [mode, setMode] = useState<Mode>('both');
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [doneInfo, setDoneInfo] = useState<{
    mode: Mode;
    title: string;
    autoShared: number;
    /** Import queued (202) — the provider is still preparing this artifact;
     * the server runs the import automatically once it lands. */
    deferred?: 'transcript' | 'video' | 'both';
    /** Queued with the artifacts already ready (202 + background) — the
     * server is pulling + transcribing right now; nothing to wait on here. */
    background?: boolean;
    /** Teams import — words the done/queued copy (Microsoft vs Google). */
    teams?: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkResults, setBulkResults] = useState<BulkResult[]>([]);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  /** True once the day sweep has SUCCESSFULLY listed the day's conferences —
   * only then can we trust "no record = meeting never happened". */
  const [sweepDone, setSweepDone] = useState(false);
  /** Did the user pick a mode by hand (don't let a late enrich() stomp it). */
  const modeTouchedRef = useRef(false);

  // --- sync tab state ---
  const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null);
  /** `${meetingCode}|${eventStart}` → who already imported that OCCURRENCE
   * (any user). Keyed per occurrence, not per code — recurring meetings
   * reuse one code, and one imported date must not mark the whole series. */
  const [importedMap, setImportedMap] = useState<Record<string, ImportedMark>>({});
  /** Same keys as importedMap → poller-cached metadata (duration, counts). */
  const [metaMap, setMetaMap] = useState<Record<string, MeetingMeta>>({});
  const [syncFrom, setSyncFrom] = useState<string | null>(null);
  /** /api/teams/check results by calendar event id. */
  const [teamsMap, setTeamsMap] = useState<Record<string, TeamsCheck>>({});
  // Microsoft (Teams chat) link — only to offer "Connect Microsoft to see
  // whether it was held" on Teams rows that have no chat verdict yet.
  const msLink = useMsLinkStatus(rows.some((r) => !!r.teamsUrl));
  const [pickedTeams, setPickedTeams] = useState<{
    row: EventRow;
    check: TeamsCheck | null;
  } | null>(null);

  /** Mute key: meeting code when there is one (Teams: the server-computed
   * teams-<hash> code once known), else the calendar event id. The poller
   * honors either. */
  const rowKey = (row: EventRow): string =>
    row.teamsUrl
      ? (teamsMap[row.event.id]?.code ?? row.event.id)
      : (row.event.conferenceData?.conferenceId ?? row.event.id);

  /** importedMap key for a row — must mirror /api/gmeet/check's response keys. */
  const markKey = (row: EventRow): string | null => {
    const code = row.event.conferenceData?.conferenceId;
    return code ? `${code}|${row.event.start?.dateTime ?? ''}` : null;
  };

  // Whenever rows change, ask the server which meeting occurrences anyone
  // has already imported — powers "in archive" / "synced by X" markers.
  useEffect(() => {
    const byKey = new Map<string, { code: string; startTime: string | null }>();
    for (const r of rows) {
      const code = r.event.conferenceData?.conferenceId;
      const key = markKey(r);
      if (code && key && !byKey.has(key)) {
        byKey.set(key, { code, startTime: r.event.start?.dateTime ?? null });
      }
    }
    if (byKey.size === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/gmeet/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meetings: [...byKey.values()] }),
        });
        if (!res.ok) return;
        const { imported, meta } = (await res.json()) as {
          imported: Record<string, ImportedMark>;
          meta?: Record<string, MeetingMeta>;
        };
        if (!cancelled) {
          setImportedMap((prev) => ({ ...prev, ...imported }));
          if (meta) setMetaMap((prev) => ({ ...prev, ...meta }));
        }
      } catch {
        // markers are cosmetic
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  // Same for Teams rows: external/imported/artifact facts from the server
  // (cache-first, no Graph calls in its hot path).
  useEffect(() => {
    const targets = rows.filter((r) => r.teamsUrl);
    if (targets.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/teams/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            events: targets.map((r) => ({
              url: r.teamsUrl,
              startTime: r.event.start?.dateTime ?? null,
            })),
          }),
        });
        if (!res.ok) return;
        const { results } = (await res.json()) as {
          results: ((Omit<TeamsCheck, 'chat'> & { chat?: unknown }) | null)[];
        };
        if (cancelled) return;
        setTeamsMap((prev) => {
          const next = { ...prev };
          targets.forEach((r, i) => {
            const res = results[i];
            if (res) next[r.event.id] = { ...res, chat: asTeamsChatVerdict(res.chat) };
          });
          return next;
        });
      } catch {
        // markers are cosmetic
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const muteRow = async (row: EventRow) => {
    const key = rowKey(row);
    setSyncInfo((prev) =>
      prev ? { ...prev, skips: new Set([...prev.skips, key]) } : prev
    );
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(row.event.id);
      return next;
    });
    try {
      await fetch('/api/gmeet/skips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventKey: key,
          title: row.event.summary ?? null,
          eventStart: row.event.start?.dateTime ?? null,
        }),
      });
    } catch (err) {
      // Optimistic; a dropped network rolls the mute back and says why.
      if (isNetworkFailure(err)) {
        setSyncInfo((prev) => {
          if (!prev) return prev;
          const skips = new Set(prev.skips);
          skips.delete(key);
          return { ...prev, skips };
        });
        setError(OFFLINE_TITLE);
      }
    }
  };

  const unmuteRow = async (row: EventRow) => {
    const key = rowKey(row);
    setSyncInfo((prev) => {
      if (!prev) return prev;
      const skips = new Set(prev.skips);
      skips.delete(key);
      return { ...prev, skips };
    });
    try {
      await fetch(`/api/gmeet/skips?eventKey=${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      // A dropped network rolls the unmute back and says why.
      if (isNetworkFailure(err)) {
        setSyncInfo((prev) => (prev ? { ...prev, skips: new Set([...prev.skips, key]) } : prev));
        setError(OFFLINE_TITLE);
      }
    }
  };

  const markSynced = useCallback(async () => {
    try {
      const res = await fetch('/api/gmeet/sync-state', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as {
          lastSyncedAt: string | null;
          skips: Array<{ event_key: string }>;
        };
        setSyncInfo({
          lastSyncedAt: data.lastSyncedAt,
          skips: new Set(data.skips.map((s) => s.event_key)),
        });
      }
    } catch (err) {
      // non-fatal — except a dropped network, which the user should see
      if (isNetworkFailure(err)) setError(OFFLINE_TITLE);
    }
  }, []);

  /**
   * Sync view: everything with a Meet presence between the user's last sync
   * (never synced → 14 days back; capped at the Meet API's ~30-day history)
   * and now — so nobody has to remember which days they already pulled in.
   */
  const loadSync = useCallback(async () => {
    setBusy(true);
    setError(null);
    setTab('sync');
    try {
      // 1. Our sync state (last sync + mutes).
      let lastSyncedAt: string | null = null;
      let skips = new Set<string>();
      try {
        const res = await fetch('/api/gmeet/sync-state');
        if (res.ok) {
          const data = (await res.json()) as {
            lastSyncedAt: string | null;
            skips: Array<{ event_key: string }>;
          };
          lastSyncedAt = data.lastSyncedAt;
          skips = new Set(data.skips.map((s) => s.event_key));
        }
      } catch {
        // sync state unavailable — fall back to the default window
      }
      setSyncInfo({ lastSyncedAt, skips });

      const lastMs = lastSyncedAt ? new Date(lastSyncedAt).getTime() : 0;
      const fromMs = Math.max(
        lastMs || Date.now() - 14 * 24 * 3600_000,
        Date.now() - 30 * 24 * 3600_000
      );
      const fromIso = new Date(fromMs).toISOString();
      setSyncFrom(fromIso);

      // 2. Calendar events + Meet conferences over the window, joined
      // server-side (and written back to the caches).
      const q = new URLSearchParams({ from: fromIso, to: new Date().toISOString(), meetOnly: '1' });
      const data = await discoveryGet<DiscoverWindowResponse>(`/api/calendar/discover?${q}`);
      const evRows = [...data.rows].sort((a, b) =>
        (b.event.start?.dateTime ?? '').localeCompare(a.event.start?.dateTime ?? '')
      );
      setSweepDone(data.meetChecked);
      setSelected(new Set());
      setRows(evRows);
      setStep('pick');
    } catch (err) {
      if (err instanceof NotConnectedError) {
        // The server says not connected — a still-cached browser token
        // would make connect() skip the re-connect redirect; drop it.
        invalidateGoogleToken();
        setStep('connect');
        setConnectPitch(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load sync view');
      // First open lands here with only the spinner rendered — move to the
      // pick step so the error (and "Switch Google account") is visible.
      setStep((s) => (s === 'connect' ? 'pick' : s));
    } finally {
      setBusy(false);
    }
  }, []);

  const reset = () => {
    setStep('connect');
    setConnectPitch(false);
    setTab('calendar');
    setError(null);
    setBusy(false);
    setRows([]);
    setPaste('');
    setPicked(null);
    setPickedTeams(null);
    setConflict(null);
    setDoneInfo(null);
    setSelected(new Set());
    setBulkResults([]);
    setBulkProgress(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  /**
   * Day view: the calendar's events for the day joined with the Meet
   * conferences that actually happened (accurate badges even when nothing is
   * attached to the event), plus meetings you joined that aren't on your
   * calendar — one server round-trip.
   */
  const loadEvents = useCallback(async (forDate: string) => {
    setBusy(true);
    setError(null);
    setTab('calendar');
    try {
      const w = dayWindow(forDate);
      const q = new URLSearchParams({ from: w.from, to: w.to });
      const data = await discoveryGet<DiscoverWindowResponse>(`/api/calendar/discover?${q}`);
      console.debug('[gmeet-import] discover', forDate, data);
      setSweepDone(data.meetChecked);
      setSelected(new Set());
      setRows(data.rows);
      setStep('pick');
    } catch (err) {
      if (err instanceof NotConnectedError) {
        // The server says not connected — a still-cached browser token
        // would make connect() skip the re-connect redirect; drop it.
        invalidateGoogleToken();
        setStep('connect');
        setConnectPitch(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load calendar');
      // First open lands here with only the spinner rendered — move to the
      // pick step so the error (and "Switch Google account") is visible.
      setStep((s) => (s === 'connect' ? 'pick' : s));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Last 30 days of conferences the user was in (Meet API only, no titles). */
  const loadRecents = useCallback(async () => {
    setBusy(true);
    setError(null);
    setTab('recent');
    try {
      const data = await discoveryGet<MeetRecordsResponse>('/api/meet/records?days=30');
      setSelected(new Set());
      setRows(data.rows);
      setStep('pick');
    } catch (err) {
      if (err instanceof NotConnectedError) {
        // The server says not connected — a still-cached browser token
        // would make connect() skip the re-connect redirect; drop it.
        invalidateGoogleToken();
        setStep('connect');
        setConnectPitch(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load recent meets');
      // First open lands here with only the spinner rendered — move to the
      // pick step so the error (and "Switch Google account") is visible.
      setStep((s) => (s === 'connect' ? 'pick' : s));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Pasted Meet link/code → list that code's conference instances. */
  const lookupPaste = useCallback(async () => {
    const code = parseMeetCode(paste);
    if (!code) {
      setError('That doesn’t look like a Meet link or code (abc-defg-hij).');
      return;
    }
    setBusy(true);
    setError(null);
    setTab('recent');
    try {
      const data = await discoveryGet<MeetRecordsResponse>(
        `/api/meet/records?code=${encodeURIComponent(code)}`
      );
      if (data.rows.length === 0) {
        setError(
          `No conference records found for ${code} — the Meet API only shows meetings you attended or organised.`
        );
        return;
      }
      setSelected(new Set());
      setRows(data.rows);
    } catch (err) {
      if (err instanceof NotConnectedError) {
        // The server says not connected — a still-cached browser token
        // would make connect() skip the re-connect redirect; drop it.
        invalidateGoogleToken();
        setStep('connect');
        setConnectPitch(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  }, [paste]);

  // Skip the connect step whenever a token is obtainable — cached in this
  // tab, or silently minted server-side for connected users. Only users who
  // never ran the one-time connect see the connect step.
  useEffect(() => {
    if (!(open && step === 'connect')) return;
    if (blocked) return; // no Connect pitch offline — the banner says why
    const start = () => {
      if (focusMeeting?.eventStart) {
        // Reminder-row click: land on that meeting's day.
        const d = isoToLocalDate(focusMeeting.eventStart);
        setDate(d);
        void loadEvents(d);
      } else if (startInSync) {
        void loadSync();
      } else {
        void loadEvents(date);
      }
    };
    if (hasValidGoogleToken()) {
      start();
      return;
    }
    let cancelled = false;
    getGoogleAccessToken()
      .then(() => {
        if (!cancelled) start();
      })
      .catch(() => {
        // Positively not connected — NOW the pitch is the right screen.
        if (!cancelled) setConnectPitch(true);
      });
    return () => {
      cancelled = true;
    };
    // `blocked` is a dep on purpose: opened during the un-probed seconds
    // before the connection verdict lands, the dialog would otherwise sit on
    // "Loading your meetings…" until closed; re-running on the flip resumes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, blocked]);

  // Scroll the focused meeting into view once its row shows up — and open
  // its import options directly: the caller clicked THIS meeting to import
  // it, so making them click the row a second time is a dead step. The row's
  // main button is disabled when the meeting isn't importable, so the
  // programmatic click is safely a no-op in that case (row stays highlighted
  // for context).
  const focusScrolledRef = useRef(false);
  useEffect(() => {
    if (open) focusScrolledRef.current = false;
  }, [open]);
  useEffect(() => {
    if (!open || !focusMeeting || focusScrolledRef.current) return;
    const el = document.getElementById('gmeet-focus-row');
    if (el) {
      el.scrollIntoView({ block: 'center' });
      focusScrolledRef.current = true;
      // Disabled = nothing importable; the row then renders its own
      // explanation + "Check again" instead of a silent no-op.
      const btn = el.querySelector<HTMLButtonElement>('button');
      if (btn && !btn.disabled) btn.click();
    }
    // teamsMap: a Teams row only becomes the focus row once /api/teams/check
    // has handed back its cache code — re-run then (the ref keeps it one-shot).
  }, [open, rows, focusMeeting, teamsMap]);

  const changeDate = (next: string) => {
    setDate(next);
    void loadEvents(next);
  };

  /** Merge the live evidence probe (Meet API artifacts + Drive metadata,
   * via /api/meet/evidence — which also writes back to the cache) into the
   * picked meeting. */
  const enrich = async (initial: PickedMeeting) => {
    try {
      const e = initial.event;
      const code = e.conferenceData?.conferenceId;
      if (!code) {
        setPicked((prev) =>
          prev && prev.event.id === initial.event.id ? { ...prev, enriching: false } : prev
        );
        return;
      }
      const body: EvidenceRequest = {
        meetingCode: code,
        // Off-calendar rows carry the record start here — same key the
        // discovery service writes, so the cache join is the right occurrence.
        startTime: e.start?.dateTime ?? null,
        recordName: initial.conferenceRecordName,
        attachments: e.attachments ?? null,
        event: {
          id: e.id,
          recurringEventId: e.recurringEventId ?? null,
          iCalUID: e.iCalUID ?? null,
          organizerEmail: e.organizer?.email ?? null,
        },
      };
      const res = await fetch('/api/meet/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Couldn’t check Google (${res.status})`);
      }
      const found = (await res.json()) as EvidenceResponse;

      const recordName = found.recordName ?? initial.conferenceRecordName;
      const videoFileId = found.recording.fileIds[0] ?? initial.videoFileId;
      let transcriptDocId = initial.transcriptDocId;
      let transcriptSource = initial.transcriptSource;
      if (!transcriptDocId && found.transcript.docIds[0]) {
        transcriptDocId = found.transcript.docIds[0];
        transcriptSource = found.transcript.source === 'gemini' ? 'gemini' : 'meet-api';
      }
      // Live check is authoritative for the pending state either way —
      // this is also how a re-check clears a stale "still preparing".
      // Unless the check itself FAILED (quota/403): keep the prior state
      // rather than letting a blip read as "nothing to import" (D5).
      let videoPending = initial.videoPending;
      let transcriptPending = initial.transcriptPending;
      if (!found.checkFailed) {
        videoPending = found.recording.state === 'generating' || found.recording.state === 'partial';
        transcriptPending = found.transcript.state === 'generating';
      }

      let applied = false;
      setPicked((prev) => {
        if (!prev || prev.event.id !== initial.event.id) return prev;
        applied = true;
        // Live values win, but a failed live fetch must not blank out what
        // the poller cache already pre-filled.
        return {
          ...prev,
          conferenceRecordName: recordName ?? prev.conferenceRecordName,
          videoFileId: videoFileId ?? prev.videoFileId,
          videoName: found.video?.name ?? prev.videoName,
          videoSize: found.video?.size ?? prev.videoSize,
          videoDurationMs: found.video?.durationMs ?? prev.videoDurationMs,
          videoCount: Math.max(prev.videoCount, found.recording.ready),
          transcriptDocId: transcriptDocId ?? prev.transcriptDocId,
          transcriptSource: transcriptSource ?? prev.transcriptSource,
          videoPending: !(videoFileId ?? prev.videoFileId) && videoPending,
          transcriptPending: !(transcriptDocId ?? prev.transcriptDocId) && transcriptPending,
          cacheMeta: found.meta ?? prev.cacheMeta,
          enriching: false,
        };
      });
      // Transcript-first default — but only for the row that's still picked,
      // and never over a choice the user already made by hand. Pending counts
      // as available: a still-preparing Doc is still the recommended path
      // (the import queues and runs when it lands).
      if (applied && !modeTouchedRef.current) {
        const docKnownBad =
          (found.meta ?? initial.cacheMeta)?.transcriptParseable === false;
        setMode(
          (transcriptDocId || transcriptPending) && !docKnownBad
            ? 'transcript'
            : videoFileId || videoPending
              ? 'video'
              : 'transcript'
        );
      }
    } catch (err) {
      setPicked((prev) =>
        prev && prev.event.id === initial.event.id ? { ...prev, enriching: false } : prev
      );
      setError(err instanceof Error ? err.message : 'Couldn’t check Google');
    }
  };

  const pickEvent = (row: EventRow, teamsCheck?: TeamsCheck | null) => {
    // Teams rows have their own options step (internal) or a guided manual
    // panel (external tenant) — nothing Meet-shaped applies to them.
    if (row.teamsUrl) {
      const check = teamsCheck ?? teamsMap[row.event.id] ?? null;
      setPickedTeams({ row, check });
      setPicked(null);
      setError(null);
      setConflict(null);
      modeTouchedRef.current = false;
      if (check?.external) {
        setStep('teams-external');
        return;
      }
      setMode(
        check?.meta?.hasTranscript
          ? 'transcript'
          : check?.meta?.hasRecording
            ? 'video'
            : 'transcript'
      );
      setStep('teams-options');
      return;
    }
    // Poller cache fills what the row itself doesn't know yet — the options
    // step renders complete immediately; enrich() just double-checks live.
    const key = markKey(row);
    const cached = key ? (metaMap[key] ?? null) : null;
    const videoFileId =
      row.video?.fileId ?? row.meet?.videoFileId ?? cached?.videoFileId ?? null;
    // Transcript source priority: explicit transcript doc → Meet API doc →
    // the Gemini notes doc (its Transcript tab — the server extracts it).
    const transcriptDocId =
      row.transcriptDoc?.fileId ??
      row.meet?.transcriptDocId ??
      row.geminiNotes?.fileId ??
      cached?.transcriptDocIds?.[0] ??
      null;
    const initial: PickedMeeting = {
      event: row.event,
      conferenceRecordName: row.meet?.recordName ?? cached?.conferenceRecord ?? null,
      videoFileId,
      videoName: row.video?.title ?? null,
      videoSize: cached?.videoSize ?? null,
      videoDurationMs: cached?.videoDurationMs ?? null,
      videoCount: row.videoCount,
      transcriptDocId,
      transcriptSource: row.transcriptDoc
        ? 'calendar'
        : row.meet?.transcriptDocId
          ? 'meet-api'
          : row.geminiNotes
            ? 'gemini'
            : cached?.transcriptDocIds?.length
              ? 'meet-api'
              : null,
      videoPending: !videoFileId && !!row.meet?.videoPending,
      transcriptPending: !transcriptDocId && !!row.meet?.transcriptPending,
      geminiNotes: !!row.geminiNotes,
      cacheMeta: cached,
      enriching: true,
      offCalendar: !!row.offCalendar,
    };
    setPicked(initial);
    setError(null);
    setConflict(null);
    modeTouchedRef.current = false;
    // Transcript-first default — unless the poller already found the Doc
    // unparseable, in which case re-transcribing is the honest suggestion.
    // Pending (still-preparing) artifacts count as available here too.
    const docKnownBad = cached?.transcriptParseable === false;
    setMode(
      (transcriptDocId || initial.transcriptPending) && !docKnownBad
        ? 'transcript'
        : videoFileId || initial.videoPending
          ? 'video'
          : 'transcript'
    );
    setStep('options');
    void enrich(initial);
  };

  /** Per-row live re-probe state for the "Check again" affordance on rows
   * the day view says have nothing (event id → checking / last note). */
  const [rowChecking, setRowChecking] = useState<string | null>(null);
  const [rowCheckNote, setRowCheckNote] = useState<Record<string, string>>({});

  /**
   * "Check again" on a row with no importable evidence: ONE live probe
   * through the discovery service — Teams: /api/teams/evidence (app-only
   * Graph, writes the cache), Meet: /api/meet/evidence — then, if the
   * provider does hold something now, open the row's import options
   * directly; otherwise say so inline. Mirrors the listing's "Check…".
   */
  const recheckRow = async (row: EventRow) => {
    const id = row.event.id;
    setRowChecking(id);
    setRowCheckNote((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      if (row.teamsUrl) {
        const res = await fetch('/api/teams/evidence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: row.teamsUrl,
            startTime: row.event.start?.dateTime ?? null,
            endTime: row.event.end?.dateTime ?? null,
            event: {
              recurringEventId: row.event.recurringEventId ?? null,
              iCalUID: row.event.iCalUID ?? null,
              organizerEmail: row.event.organizer?.email ?? null,
            },
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          external?: boolean;
          tenantId?: string;
          code?: string;
          resolved?: boolean;
          imported?: ImportedMark | null;
          meta?: TeamsCheck['meta'];
          verdict?: { importable?: boolean };
          checkFailed?: boolean;
          error?: string;
          chat?: unknown;
        };
        if (!res.ok) throw new Error(j.error || `Check failed (${res.status})`);
        // The evidence route now also carries the Teams chat verdict (held /
        // recorded) — for external meetings too, where it is all we get.
        const chat = asTeamsChatVerdict(j.chat) ?? teamsMap[id]?.chat ?? null;
        if (j.external) {
          const check: TeamsCheck = { external: true, tenantId: j.tenantId, code: j.code, chat };
          setTeamsMap((prev) => ({ ...prev, [id]: check }));
          pickEvent(row, check);
          return;
        }
        if (j.checkFailed) {
          if (chat) setTeamsMap((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { external: false }), chat } }));
          setRowCheckNote((prev) => ({ ...prev, [id]: j.error || 'Microsoft didn’t answer — try again' }));
          return;
        }
        const check: TeamsCheck = {
          external: false,
          code: j.code,
          imported: j.imported ?? null,
          meta: j.meta ?? null,
          chat,
        };
        setTeamsMap((prev) => ({ ...prev, [id]: check }));
        if (j.verdict?.importable) {
          onImported?.(); // listing refetch — the row migrates to "Not imported"
          pickEvent(row, check);
        } else {
          setRowCheckNote((prev) => ({
            ...prev,
            [id]: chat
              ? // The verdict line on the row carries the chat finding; the note
                // adds the artifact side so the two read as one sentence.
                `${teamsChatVerdictCopy(chat, { external: false }).text} — nothing importable at Microsoft yet`
              : j.resolved === false
                ? 'Microsoft has no record of this meeting'
                : 'Still nothing at Microsoft',
          }));
        }
        return;
      }
      const code = row.event.conferenceData?.conferenceId;
      if (!code) return;
      const body: EvidenceRequest = {
        meetingCode: code,
        startTime: row.event.start?.dateTime ?? null,
        recordName: row.meet?.recordName ?? null,
        attachments: row.event.attachments ?? null,
        event: {
          id: row.event.id,
          recurringEventId: row.event.recurringEventId ?? null,
          iCalUID: row.event.iCalUID ?? null,
          organizerEmail: row.event.organizer?.email ?? null,
        },
      };
      const res = await fetch('/api/meet/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 404) throw new NotConnectedError();
      const j = (await res.json().catch(() => ({}))) as EvidenceResponse & { error?: string };
      if (!res.ok) throw new Error(j.error || `Check failed (${res.status})`);
      if (j.checkFailed) {
        setRowCheckNote((prev) => ({ ...prev, [id]: 'Google didn’t answer — try again' }));
        return;
      }
      // Fold the probe into the row the same way the day sweep would have
      // (server-side meetInfoOf) so badges / importability re-derive.
      const meet = j.recordName
        ? {
            recordName: j.recordName,
            videoFileId: j.recording.fileIds[0] ?? null,
            transcriptDocId: j.transcript.docIds[0] ?? null,
            videoPending: j.recording.state === 'generating' || j.recording.state === 'partial',
            transcriptPending: j.transcript.state === 'generating',
            checked: true,
          }
        : null;
      const updated: EventRow = { ...row, meet };
      setRows((prev) => prev.map((r) => (r.event.id === id ? updated : r)));
      if (j.verdict.importable) {
        onImported?.();
        pickEvent(updated);
      } else {
        setRowCheckNote((prev) => ({
          ...prev,
          [id]: j.recordName ? 'Still nothing at Google' : 'Google has no record of this meeting',
        }));
      }
    } catch (err) {
      if (err instanceof NotConnectedError) {
        setConnectPitch(true);
        return;
      }
      setRowCheckNote((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Check failed',
      }));
    } finally {
      setRowChecking((cur) => (cur === id ? null : cur));
    }
  };

  /** Can this row be bulk quick-imported (transcript-only)? Requires real
   * evidence a transcript can exist: a transcript/Gemini doc (from the
   * calendar, the Meet API, or the poller cache). A bare Meet link is NOT
   * enough — scheduled-but-never-started meetings have one too. And once
   * the artifacts HAVE been checked (Meet API row or cache) with no
   * transcript found, quick import can only fail — asking users to bulk-run
   * those is the "sync asks you to do gibberish" problem. */
  const bulkEligible = (row: EventRow): boolean => {
    const key = markKey(row);
    const meta = key ? metaMap[key] : undefined;
    if (
      row.transcriptDoc ||
      row.geminiNotes ||
      row.meet?.transcriptDocId ||
      meta?.transcriptDocIds?.length
    ) {
      return true;
    }
    // Artifacts inventoried and no transcript among them → nothing to
    // quick-import. Unchecked rows (recents) stay eligible: resolved on run.
    if (row.meet?.checked || meta) return false;
    return !!row.meet?.recordName;
  };

  const toggleSelect = (rowId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else if (next.size < MAX_BULK) next.add(rowId);
      return next;
    });
  };

  /** Mass quick-import: transcript-only, sequential, per-row results. */
  const runBulkImport = async () => {
    const targets = rows.filter((r) => selected.has(r.event.id));
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    setBulkResults([]);
    setBulkProgress({ done: 0, total: targets.length });
    setStep('bulk');
    const results: BulkResult[] = [];
    for (const row of targets) {
      const e = row.event;
      const title = row.offCalendar
        ? `${e.summary ?? 'Meet'} — ${fmtDayTime(e.start?.dateTime)}`
        : (e.summary ?? '(no title)');
      try {
        const token = await getGoogleAccessToken();
        const res = await fetch('/api/gmeet/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: token,
            mode: 'transcript',
            transcriptDocId:
              row.transcriptDoc?.fileId ??
              row.meet?.transcriptDocId ??
              row.geminiNotes?.fileId ??
              undefined,
            conferenceRecordName: row.meet?.recordName ?? undefined,
            event: {
              id: e.id,
              title: row.offCalendar ? undefined : e.summary,
              startTime: e.start?.dateTime,
              endTime: e.end?.dateTime,
              meetingCode: e.conferenceData?.conferenceId,
              recurringEventId: e.recurringEventId,
              iCalUID: e.iCalUID,
              organizerEmail: e.organizer?.email,
              attendees: (e.attendees ?? [])
                .filter((a) => a.email)
                .map((a) => ({
                  email: a.email!,
                  name: a.displayName,
                  responseStatus: a.responseStatus,
                })),
            },
          }),
        });
        if (res.status === 409) {
          const detail = (await res.json()) as { existing?: { assemblyai_id?: string } };
          results.push({
            rowId: e.id,
            title,
            status: 'exists',
            transcriptId: detail.existing?.assemblyai_id,
          });
        } else if (res.ok) {
          const payload = (await res.json()) as { transcript?: { assemblyai_id?: string } };
          results.push({
            rowId: e.id,
            title,
            status: 'ok',
            transcriptId: payload.transcript?.assemblyai_id,
          });
        } else {
          const detail = await res.json().catch(() => ({}) as { error?: string });
          results.push({
            rowId: e.id,
            title,
            status: 'error',
            detail: detail.error || `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        results.push({
          rowId: e.id,
          title,
          status: 'error',
          detail: err instanceof Error ? err.message : 'failed',
        });
      }
      setBulkResults([...results]);
      setBulkProgress({ done: results.length, total: targets.length });
    }
    setBusy(false);
    setSelected(new Set());
    if (tab === 'sync') {
      // A bulk run from the sync view IS a sync pass — move the marker so
      // the next visit starts where this one ended.
      void markSynced();
      // Meetings that failed because there is simply nothing to import
      // (never recorded/transcribed) will never succeed — mute them so they
      // don't come back as "unsynced" noise. Other errors stay retryable.
      for (const r of results) {
        if (r.status === 'error' && /no meet transcript/i.test(r.detail ?? '')) {
          const row = targets.find((t) => t.event.id === r.rowId);
          if (row) void muteRow(row);
        }
      }
    }
    onImported?.();
  };

  const runImport = async (force = false) => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    setStep('importing');
    try {
      const token = await getGoogleAccessToken();
      const e = picked.event;
      const res = await fetch('/api/gmeet/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: token,
          mode,
          videoFileId: picked.videoFileId ?? undefined,
          transcriptDocId: picked.transcriptDocId ?? undefined,
          conferenceRecordName: picked.conferenceRecordName ?? undefined,
          force,
          // If the mode's artifact is listed but Google hasn't generated the
          // file yet, queue the import instead of failing — the server runs
          // it automatically the moment the file lands.
          defer: true,
          // Even when everything IS ready, don't pull the video inline: the
          // server queues it and imports in the background, so this request
          // returns in seconds and closing the tab kills nothing.
          background: true,
          event: {
            id: e.id,
            title: picked.offCalendar ? undefined : e.summary,
            startTime: e.start?.dateTime,
            endTime: e.end?.dateTime,
            meetingCode: e.conferenceData?.conferenceId,
            recurringEventId: e.recurringEventId,
            iCalUID: e.iCalUID,
            organizerEmail: e.organizer?.email,
            attendees: (e.attendees ?? [])
              .filter((a) => a.email)
              .map((a) => ({
                email: a.email!,
                name: a.displayName,
                responseStatus: a.responseStatus,
              })),
          },
        }),
      });

      if (res.status === 409) {
        const detail = (await res.json()) as {
          existing?: {
            assemblyai_id?: string | null;
            own?: boolean;
            title?: string | null;
            ownerEmail?: string | null;
            accessible?: boolean;
          };
        };
        setConflict({
          ownerEmail: detail.existing?.ownerEmail ?? null,
          accessible: detail.existing?.accessible !== false,
          id: detail.existing?.assemblyai_id ?? '',
          title: detail.existing?.title ?? null,
          own: !!detail.existing?.own,
        });
        setStep('options');
        return;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(detail.error || `Import failed (${res.status})`);
      }

      const payload = (await res.json()) as {
        autoShared?: number;
        deferred?: boolean;
        background?: boolean;
        waitingFor?: 'transcript' | 'video' | 'both';
      };
      setDoneInfo({
        mode,
        title: picked.offCalendar
          ? `${e.summary ?? 'Meet'} — ${fmtDayTime(e.start?.dateTime)}`
          : (e.summary ?? 'Untitled meeting'),
        autoShared: payload.autoShared ?? 0,
        deferred:
          payload.deferred && !payload.background ? (payload.waitingFor ?? 'both') : undefined,
        background: payload.background,
      });
      setStep('done');
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setStep('options');
    } finally {
      setBusy(false);
    }
  };

  /** Import a Teams meeting — the server resolves artifacts app-only from
   * the join URL; no Google/Microsoft token leaves the browser. */
  const runTeamsImport = async (force = false) => {
    if (!pickedTeams) return;
    const e = pickedTeams.row.event;
    setBusy(true);
    setError(null);
    setConflict(null);
    setStep('importing');
    try {
      const res = await fetch('/api/teams/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: pickedTeams.row.teamsUrl,
          mode,
          force,
          // Microsoft is still processing the artifacts → queue instead of
          // failing; the deferred-import poller finishes it automatically.
          defer: true,
          // Ready artifacts also import in the background (202 in seconds)
          // instead of holding this request open for the whole MP4 pull.
          background: true,
          event: {
            id: e.id,
            title: e.summary,
            startTime: e.start?.dateTime,
            endTime: e.end?.dateTime,
            recurringEventId: e.recurringEventId,
            iCalUID: e.iCalUID,
            organizerEmail: e.organizer?.email,
            attendees: (e.attendees ?? [])
              .filter((a) => a.email)
              .map((a) => ({
                email: a.email!,
                name: a.displayName,
                responseStatus: a.responseStatus,
              })),
          },
        }),
      });
      if (res.status === 409) {
        const detail = (await res.json()) as {
          existing?: {
            assemblyai_id?: string | null;
            own?: boolean;
            title?: string | null;
            ownerEmail?: string | null;
            accessible?: boolean;
          };
        };
        setConflict({
          ownerEmail: detail.existing?.ownerEmail ?? null,
          accessible: detail.existing?.accessible !== false,
          id: detail.existing?.assemblyai_id ?? '',
          title: detail.existing?.title ?? null,
          own: !!detail.existing?.own,
        });
        setStep('teams-options');
        return;
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(detail.error || `Import failed (${res.status})`);
      }
      const payload = (await res.json()) as {
        autoShared?: number;
        deferred?: boolean;
        background?: boolean;
        waitingFor?: 'transcript' | 'video' | 'both';
      };
      setDoneInfo({
        mode,
        title: e.summary ?? 'Untitled meeting',
        autoShared: payload.autoShared ?? 0,
        deferred:
          payload.deferred && !payload.background ? (payload.waitingFor ?? 'both') : undefined,
        background: payload.background,
        teams: true,
      });
      setStep('done');
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setStep('teams-options');
    } finally {
      setBusy(false);
    }
  };

  /** Teams join: access proof is the stored invite list, checked server-side. */
  const joinTeamsExisting = async () => {
    if (!pickedTeams?.row.teamsUrl) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/teams/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: pickedTeams.row.teamsUrl,
          startTime: pickedTeams.row.event.start?.dateTime ?? null,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        transcriptId?: string;
        error?: string;
      };
      if (!res.ok || !payload.transcriptId) {
        throw new Error(payload.error || `Join failed (${res.status})`);
      }
      onImported?.();
      window.location.href = `/transcript/${payload.transcriptId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Join failed');
      setBusy(false);
    }
  };

  /**
   * Join a colleague's existing import instead of cloning it. The server
   * verifies — with OUR token — that Google gives us access to the meeting
   * (we were in it, or its artifacts are shared with us) before granting a
   * share on the existing row.
   */
  const joinExisting = async () => {
    if (!picked?.event.conferenceData?.conferenceId) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getGoogleAccessToken();
      const res = await fetch('/api/gmeet/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingCode: picked.event.conferenceData.conferenceId,
          startTime: picked.event.start?.dateTime ?? null,
          accessToken: token,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        transcriptId?: string;
        error?: string;
      };
      if (!res.ok || !payload.transcriptId) {
        throw new Error(payload.error || `Join failed (${res.status})`);
      }
      onImported?.();
      window.location.href = `/transcript/${payload.transcriptId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Join failed');
      setBusy(false);
    }
  };

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      // Already connected (fresh browser, cache empty) → straight through.
      await getGoogleAccessToken();
      if (startInSync) await loadSync();
      else await loadEvents(date);
    } catch (err) {
      if (err instanceof GoogleNotConnectedError) {
        // One-time app-wide connect; the callback reopens this dialog.
        connectGoogle(startInSync ? '/?meet=sync' : '/?meet=1');
        return; // navigating away
      }
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? handleClose() : null)}>
      {/* sm:max-w-2xl (not max-w-2xl): DialogContent ships sm:max-w-lg and
          twMerge only replaces within the same breakpoint group — a base
          max-w-2xl loses to it and the content overflows the 512px card. */}
      <DialogContent className="sm:max-w-2xl rounded-xl shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            {step === 'teams-options' || step === 'teams-external'
              ? 'Import from Microsoft Teams'
              : 'Import a meeting'}
          </DialogTitle>
        </DialogHeader>

        {blocked && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300" data-gmeet-offline-banner>
            {OFFLINE_TITLE}
          </p>
        )}

        {step === 'connect' && !connectPitch && !blocked && (
          <div className="py-10 text-center">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">Loading your meetings…</p>
          </div>
        )}
        {step === 'connect' && !connectPitch && blocked && (
          <p className="py-10 text-center text-sm text-muted-foreground">{OFFLINE_TITLE}</p>
        )}

        <fieldset disabled={blocked} className="contents">

        {step === 'connect' && connectPitch && (
          <div className="space-y-4 py-2 min-w-0">
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="font-medium mb-1">Pull a meeting straight from your calendar</p>
              <p className="text-muted-foreground">
                Connect your Trames Google account once (read-only: Calendar + Drive + Meet +
                directory) — imports, background sync and meeting reminders all use it from
                then on, no repeated sign-in popups. Pick the meeting and we&apos;ll fetch its
                recording and/or Meet transcript — no downloading and re-uploading.
              </p>
            </div>
            {error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )}
          </div>
        )}

        {step === 'pick' && (
          // min-w-0: DialogContent is a grid; without it this item sizes to
          // its content's min-content and paints outside the card.
          <div className="space-y-3 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center rounded-md border p-0.5">
                <Button
                  variant={tab === 'calendar' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => void loadEvents(date)}
                  disabled={busy}
                >
                  Calendar
                </Button>
                <Button
                  variant={tab === 'recent' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => void loadRecents()}
                  disabled={busy}
                  title="Meetings you were in over the last 30 days (via the Meet API)"
                >
                  <History className="h-3.5 w-3.5 mr-1" />
                  Recent 30d
                </Button>
                <Button
                  variant={tab === 'sync' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => void loadSync()}
                  disabled={busy}
                  title="Everything since your last sync — import the lot in one go"
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  Sync
                </Button>
              </div>
              {tab === 'calendar' && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => changeDate(shiftDate(date, -1))}
                    disabled={busy}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => e.target.value && changeDate(e.target.value)}
                    className="w-36"
                    disabled={busy}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => changeDate(shiftDate(date, 1))}
                    disabled={busy}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
              {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>

            {tab === 'sync' && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <span>
                  {syncInfo?.lastSyncedAt
                    ? `Last synced ${relDays(syncInfo.lastSyncedAt)} — showing meetings since then.`
                    : 'Never synced — showing the last 14 days.'}
                  {syncFrom &&
                    ` (${new Date(syncFrom).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} → today)`}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    title="Select every pending meeting with a transcript"
                    onClick={() => {
                      const pending = rows.filter((r) => {
                        const key = markKey(r);
                        const mark = key ? importedMap[key] : undefined;
                        return (
                          bulkEligible(r) &&
                          !mark &&
                          !syncInfo?.skips.has(rowKey(r)) &&
                          // Known-unparseable Docs would just fail the bulk
                          // run — leave them for a deliberate manual pick.
                          (key ? metaMap[key]?.transcriptParseable !== false : true)
                        );
                      });
                      setSelected(new Set(pending.slice(0, MAX_BULK).map((r) => r.event.id)));
                    }}
                  >
                    Select all pending
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    title="Nothing (more) to pull in — move the sync marker to now"
                    onClick={() => void markSynced()}
                  >
                    Mark as synced
                  </Button>
                </span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="…or paste a Meet link / code (abc-defg-hij) someone sent you"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && paste.trim()) void lookupPaste();
                }}
                className="text-sm"
                disabled={busy}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void lookupPaste()}
                disabled={busy || !paste.trim()}
              >
                Find
              </Button>
            </div>

            <div className="max-h-[45vh] overflow-y-auto rounded-md border">
              {rows.length === 0 && !busy ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {tab === 'calendar' ? 'No meetings on this day.' : 'No meetings found.'}
                </p>
              ) : (
                <ul className="divide-y">
                  {rows.map((row) => {
                    const key = markKey(row);
                    const isTeams = !!row.teamsUrl;
                    const teams = isTeams ? (teamsMap[row.event.id] ?? null) : null;
                    const teamsExternal = teams?.external === true;
                    const mark = isTeams
                      ? (teams?.imported ?? undefined)
                      : key
                        ? importedMap[key]
                        : undefined;
                    const meta = key ? metaMap[key] : undefined;
                    const hasVideo = isTeams
                      ? teams?.meta?.hasRecording === true
                      : !!(
                          row.video ||
                          row.meet?.videoFileId ||
                          meta?.videoFileId || // attachment-video-only rows
                          (meta?.readyRecordingCount ?? 0) > 0
                        );
                    const hasTranscript = isTeams
                      ? teams?.meta?.hasTranscript === true
                      : !!(
                          row.transcriptDoc ||
                          row.meet?.transcriptDocId ||
                          row.geminiNotes ||
                          meta?.transcriptDocIds?.length
                        );
                    // Recorded/transcribed, but Google is still generating the
                    // files (state ENDED, no Drive file / Doc id yet).
                    const preparing =
                      !isTeams &&
                      ((!hasVideo && !!row.meet?.videoPending) ||
                        (!hasTranscript && !!row.meet?.transcriptPending));
                    // Artifacts inventoried (Meet API sweep or poller cache)
                    // and none found → the meeting ran but produced nothing
                    // importable. Don't invite a doomed click.
                    const checkedEmpty =
                      !isTeams && !!row.meet?.checked && !hasVideo && !hasTranscript && !preparing;
                    // Teams twin: the poller (or a Check) already asked
                    // Microsoft about this occurrence and it listed neither
                    // artifact — a click would open an options step with
                    // nothing to pick. Unknown (no cache row yet) stays
                    // clickable: artifacts are re-checked at import time.
                    const teamsCheckedEmpty =
                      isTeams && !teamsExternal && !!teams?.meta && !hasVideo && !hasTranscript;
                    // Before the day sweep confirms which meetings actually
                    // happened, a Meet link is enough to try; after it, a
                    // link with no conference record = never started. Teams
                    // rows are clickable unless known-empty — internal ones
                    // import (artifacts re-checked server-side), external
                    // ones open the guided manual panel.
                    const importable = isTeams
                      ? !teamsCheckedEmpty
                      : !checkedEmpty &&
                        (hasVideo ||
                          hasTranscript ||
                          !!row.meet ||
                          (!sweepDone && !!row.event.conferenceData?.conferenceId));
                    // A row with nothing importable that a live re-probe could
                    // still change: offer "Check again" right on the row.
                    const recheckable =
                      !importable &&
                      !mark &&
                      (teamsCheckedEmpty ||
                        (!isTeams && !!row.event.conferenceData?.conferenceId));
                    const muted = !!syncInfo?.skips.has(rowKey(row));
                    const focused =
                      !!focusMeeting?.meetingCode &&
                      (row.event.conferenceData?.conferenceId === focusMeeting.meetingCode ||
                        (isTeams && teams?.code === focusMeeting.meetingCode));
                    const rowNote = rowCheckNote[row.event.id];
                    const providerName = isTeams ? 'Microsoft' : 'Google';
                    // Teams chat evidence for rows with nothing importable:
                    // the verdict line ("Held 51 min · not recorded"), or the
                    // connect hint when the caller has no Microsoft link.
                    const teamsChat = isTeams && !hasVideo && !hasTranscript ? (teams?.chat ?? null) : null;
                    const teamsChatHint =
                      isTeams && !hasVideo && !hasTranscript && !teamsChat && !mark && msLinkMissing(msLink);
                    return (
                      <li
                        key={row.event.id}
                        id={focused ? 'gmeet-focus-row' : undefined}
                        className={`flex flex-col ${muted ? 'opacity-45' : ''} ${
                          focused
                            ? 'bg-primary/10 ring-2 ring-inset ring-primary/60 shadow-[inset_3px_0_0_0_hsl(var(--primary))]'
                            : ''
                        }`}
                      >
                      <div className="flex items-center">
                        {bulkEligible(row) && !mark && !muted ? (
                          <input
                            type="checkbox"
                            className="ml-3 h-4 w-4 shrink-0"
                            checked={selected.has(row.event.id)}
                            onChange={() => toggleSelect(row.event.id)}
                            disabled={busy}
                            title="Select for bulk quick-import (transcript only)"
                          />
                        ) : (
                          <span className="ml-3 w-4 shrink-0" />
                        )}
                        <button
                          type="button"
                          onClick={() => importable && pickEvent(row)}
                          disabled={!importable || busy}
                          className={`w-full text-left flex items-center gap-3 p-3 min-w-0 ${
                            importable
                              ? 'hover:bg-muted/50 cursor-pointer'
                              : 'opacity-50 cursor-default'
                          }`}
                        >
                          <span
                            className={`text-xs text-muted-foreground shrink-0 ${
                              tab === 'calendar' ? 'w-16' : 'w-24'
                            }`}
                          >
                            {tab === 'calendar'
                              ? fmtEventTime(row.event)
                              : fmtDayTime(row.event.start?.dateTime)}
                          </span>
                          {/* Provider identity — always visually distinct in
                              the same list (spec §10.1). */}
                          {isTeams ? (
                            <TeamsLogo
                              className={`h-4 w-4 shrink-0 ${teamsExternal ? 'opacity-60' : ''}`}
                              muted={teamsExternal}
                            />
                          ) : (
                            (row.event.conferenceData?.conferenceId || row.meet) && (
                              <MeetLogo className="h-4 w-4 shrink-0" />
                            )
                          )}
                          <span className="flex-1 min-w-0 truncate text-sm">
                            {row.event.summary ?? '(no title)'}
                            {teamsExternal && (
                              <span className="ml-2 text-[11px] text-muted-foreground">
                                organized outside Trames
                                {row.event.organizer?.email?.includes('@') &&
                                  ` (${row.event.organizer.email.split('@')[1]})`}{' '}
                                — manual import
                              </span>
                            )}
                          </span>
                          {mark && mark.accessible && (
                            <Badge
                              variant="outline"
                              className="text-[10px] gap-1 shrink-0 border-status-ok/40 text-status-ok"
                              title={
                                mark.mine
                                  ? 'Already in your archive'
                                  : `Imported by ${mark.ownerEmail ?? 'a colleague'} and shared with you`
                              }
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              in archive
                            </Badge>
                          )}
                          {mark && !mark.accessible && (
                            <Badge
                              variant="outline"
                              className="text-[10px] gap-1 shrink-0"
                              title={`${mark.ownerEmail ?? 'A colleague'} already imported this meeting (not shared with you — ask them for access)`}
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              synced by {mark.ownerEmail?.split('@')[0] ?? 'a colleague'}
                            </Badge>
                          )}
                          {muted && (
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              muted
                            </span>
                          )}
                          {hasVideo && (
                            <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
                              <Video className="h-3 w-3" />
                              recording{row.videoCount > 1 ? ` ×${row.videoCount}` : ''}
                              {meta?.videoDurationMs != null &&
                                ` · ${fmtDurationMs(meta.videoDurationMs)}`}
                            </Badge>
                          )}
                          {preparing && (
                            <Badge
                              variant="outline"
                              className="text-[10px] gap-1 shrink-0 border-amber-400/60 text-amber-600 dark:text-amber-500"
                              title="The meeting was recorded — Google is still preparing the files. They usually land within minutes of the call ending."
                            >
                              <Loader2 className="h-3 w-3 animate-spin" />
                              preparing…
                            </Badge>
                          )}
                          {hasTranscript && meta?.transcriptParseable === false ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] gap-1 shrink-0 border-amber-400/60 text-amber-600 dark:text-amber-500"
                              title="Meet's transcript Doc looks empty or unparseable — quick import will likely fail; re-transcribe the recording instead"
                            >
                              <AlertCircle className="h-3 w-3" />
                              transcript?
                            </Badge>
                          ) : (
                            hasTranscript && (
                              <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
                                <FileText className="h-3 w-3" />
                                transcript
                                {meta?.utteranceCount != null &&
                                  meta.utteranceCount > 0 &&
                                  ` · ${meta.utteranceCount} turns`}
                              </Badge>
                            )
                          )}
                          {!importable && (
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {checkedEmpty || teamsCheckedEmpty
                                ? 'nothing to import'
                                : row.event.conferenceData?.conferenceId
                                  ? 'never started'
                                  : 'no meet link'}
                            </span>
                          )}
                          {teamsChat && (
                            <TeamsChatVerdictLine
                              verdict={teamsChat}
                              external={teamsExternal ? true : teams ? false : null}
                            />
                          )}
                        </button>
                        {teamsChatHint && <ConnectMicrosoftHint className="mr-2" />}
                        {recheckable && (
                          <Button
                            size="sm"
                            variant={focused ? 'outline' : 'ghost'}
                            className="mr-2 h-7 shrink-0 px-2 text-[11px]"
                            disabled={busy || rowChecking === row.event.id}
                            title={`Ask ${providerName} again whether this meeting left a recording or transcript`}
                            onClick={() => void recheckRow(row)}
                          >
                            {rowChecking === row.event.id ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-1 h-3 w-3" />
                            )}
                            Check again
                          </Button>
                        )}
                        {tab === 'sync' && !mark && (
                          <button
                            type="button"
                            onClick={() => void (muted ? unmuteRow(row) : muteRow(row))}
                            disabled={busy}
                            className="mr-2 shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                            title={
                              muted
                                ? 'Un-mute — offer this meeting for sync again'
                                : 'Never sync this meeting (mute it from sync reminders)'
                            }
                          >
                            <BellOff className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {/* The caller landed HERE on this row (listing / reminder
                          click) and there is nothing to select — say why
                          instead of a silent no-op. */}
                      {(focused && !importable && !mark) || rowNote ? (
                        <p className="flex items-center gap-1.5 px-3 pb-2 pl-10 text-[11px] text-muted-foreground">
                          <AlertCircle className="h-3 w-3 shrink-0" />
                          {rowNote ??
                            (teamsCheckedEmpty || checkedEmpty
                              ? `Nothing at ${providerName} yet — no recording or transcript was listed for this occurrence. Recap artifacts usually land minutes after the call; if the call was recorded, Check again in a bit.`
                              : row.event.conferenceData?.conferenceId
                                ? 'Google has no conference record for this occurrence — the Meet call never started (or the record has aged out). Check again asks Google directly.'
                                : 'This event has no meeting link — upload a recording from the listing instead.')}
                        </p>
                      ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {selected.size > 0 && (
              <p className="text-xs text-muted-foreground">
                {selected.size}/{MAX_BULK} selected for quick-import (Meet transcript only —
                you can re-run diarization on any of them later).
              </p>
            )}
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
              disabled={busy}
              onClick={() => {
                // Full-page re-connect (forces Google's account chooser);
                // the callback lands back here with the dialog reopened.
                setBusy(true);
                void switchGoogleAccount('/?meet=1');
              }}
            >
              Wrong calendar? Switch Google account
            </button>
            {error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )}
          </div>
        )}

        {step === 'bulk' && (
          <div className="space-y-3 min-w-0">
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy
                ? `Importing ${(bulkProgress?.done ?? 0) + 1} of ${bulkProgress?.total}…`
                : `Done — ${bulkResults.filter((r) => r.status === 'ok').length} imported, ${bulkResults.filter((r) => r.status === 'exists').length} already existed, ${bulkResults.filter((r) => r.status === 'error').length} failed.`}
            </p>
            {!busy && tab === 'sync' && (
              <p className="text-xs text-muted-foreground">
                Sync point updated — next sync starts from now.
                {bulkResults.some(
                  (r) => r.status === 'error' && /no meet transcript/i.test(r.detail ?? '')
                ) &&
                  ' Meetings with no Meet transcript were muted (nothing to import — they won’t be offered again).'}
              </p>
            )}
            <div className="max-h-[50vh] overflow-y-auto rounded-md border">
              <ul className="divide-y">
                {bulkResults.map((r) => (
                  <li key={r.rowId} className="flex items-center gap-2 p-3 text-xs">
                    {r.status === 'ok' && (
                      <CheckCircle2 className="h-4 w-4 text-status-ok shrink-0" />
                    )}
                    {r.status === 'exists' && (
                      <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    {r.status === 'error' && (
                      <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                    )}
                    <span className="flex-1 min-w-0 truncate">{r.title}</span>
                    {r.status === 'exists' && (
                      <span className="text-muted-foreground shrink-0">already imported</span>
                    )}
                    {r.status === 'error' && (
                      <span className="text-destructive truncate max-w-[40%]">{r.detail}</span>
                    )}
                    {r.transcriptId && (
                      <a
                        href={`/transcript/${r.transcriptId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0"
                      >
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                          <ExternalLink className="h-3 w-3 mr-1" />
                          open
                        </Button>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        </fieldset>

        {step === 'teams-options' && pickedTeams && (
          <div className="space-y-4 min-w-0">
            <fieldset disabled={blocked} className="contents">
            <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
              <p className="text-sm font-medium flex items-center gap-2">
                <TeamsLogo className="h-4 w-4 shrink-0" />
                {pickedTeams.row.event.summary ?? '(no title)'}
              </p>
              <p className="text-xs text-muted-foreground">
                {fmtEventRange(pickedTeams.row.event)}
              </p>
              {(pickedTeams.row.event.attendees ?? []).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">
                    {(pickedTeams.row.event.attendees ?? []).length} invitees:
                  </span>{' '}
                  {inviteeSummary(pickedTeams.row.event)}
                </p>
              )}
              <div className="pt-1 space-y-0.5">
                {pickedTeams.check?.meta ? (
                  <>
                    {pickedTeams.check.meta.hasRecording ? (
                      <p className="text-xs flex items-center gap-1">
                        <Video className="h-3 w-3 shrink-0" />
                        Recording available (fetched from Microsoft 365 — no login needed)
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">No recording found yet.</p>
                    )}
                    {pickedTeams.check.meta.hasTranscript ? (
                      <p className="text-xs flex items-center gap-1">
                        <FileText className="h-3 w-3 shrink-0" />
                        Teams transcript available (speaker-attributed)
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">No transcript found yet.</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Artifacts are checked at import time — if the call just ended, Microsoft
                    may still be preparing them for a few minutes.
                  </p>
                )}
              </div>
            </div>

            {conflict && (
              <div className="rounded-md border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
                <p className="text-sm">
                  Already imported by{' '}
                  {conflict.own ? 'you' : (conflict.ownerEmail ?? 'a teammate')}
                  {conflict.title ? (
                    <>
                      {' '}
                      — <span className="font-medium">{conflict.title}</span>
                    </>
                  ) : null}
                  {conflict.accessible === false
                    ? ". It hasn't been shared with you — if you were on the invite, you can join their import instead of making a duplicate."
                    : ". It's in your list (invitees are shared in automatically)."}
                </p>
                <div className="flex gap-2 flex-wrap">
                  {conflict.id && (
                    <a href={`/transcript/${conflict.id}`}>
                      <Button size="sm">
                        <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                        Open transcript
                      </Button>
                    </a>
                  )}
                  {conflict.accessible === false && (
                    <Button size="sm" onClick={() => void joinTeamsExisting()} disabled={busy}>
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Join their import
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runTeamsImport(true)}
                    disabled={busy}
                  >
                    {conflict.own ? 'Re-import (overwrites yours)' : 'Import my own copy anyway'}
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer has-[:checked]:border-primary">
                <input
                  type="radio"
                  name="teams-mode"
                  checked={mode === 'transcript'}
                  onChange={() => {
                    modeTouchedRef.current = true;
                    setMode('transcript');
                  }}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">Quick import — Teams transcript only.</span>{' '}
                  <span className="text-muted-foreground">
                    Instant and free: real speaker names from Teams, no audio. You can attach
                    the recording later.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer has-[:checked]:border-primary">
                <input
                  type="radio"
                  name="teams-mode"
                  checked={mode === 'video'}
                  onChange={() => {
                    modeTouchedRef.current = true;
                    setMode('video');
                  }}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">Re-transcribe the recording.</span>{' '}
                  <span className="text-muted-foreground">
                    Downloads the MP4 and runs the normal pipeline — acoustic speaker
                    separation, playback, video features.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer has-[:checked]:border-primary">
                <input
                  type="radio"
                  name="teams-mode"
                  checked={mode === 'both'}
                  onChange={() => {
                    modeTouchedRef.current = true;
                    setMode('both');
                  }}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">Both.</span>{' '}
                  <span className="text-muted-foreground">
                    Re-transcribe the recording and keep the Teams transcript as a sidecar
                    for name cross-referencing.
                  </span>
                </span>
              </label>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            </fieldset>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('pick')} disabled={busy}>
                <ChevronLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
              <Button onClick={() => void runTeamsImport()} disabled={busy || blocked} title={blocked ? OFFLINE_TITLE : undefined}>
                {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
                Import
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'teams-external' && pickedTeams && (
          <div className="space-y-4 min-w-0">
            <fieldset disabled={blocked} className="contents">
            <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
              <p className="text-sm font-medium flex items-center gap-2">
                <TeamsLogo className="h-4 w-4 shrink-0" muted />
                {pickedTeams.row.event.summary ?? '(no title)'}
              </p>
              <p className="text-xs text-muted-foreground">
                {fmtEventRange(pickedTeams.row.event)}
              </p>
              {pickedTeams.check?.chat && (
                <p className="text-xs">
                  <TeamsChatVerdictLine verdict={pickedTeams.check.chat} external />
                </p>
              )}
            </div>

            <p className="text-sm">
              This Teams meeting was organized outside Trames
              {pickedTeams.row.event.organizer?.email?.includes('@') && (
                <> (by {pickedTeams.row.event.organizer.email.split('@')[1]})</>
              )}{' '}
              — <span className="font-medium">their tenant owns the recording and
              transcript</span>, so we can&apos;t pull them automatically. Two ways to get it
              in, best first:
            </p>

            <div className="space-y-2">
              <div className="rounded-md border p-3 space-y-1">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Video className="h-3.5 w-3.5" />
                  1. Upload the recording video (recommended)
                </p>
                <p className="text-xs text-muted-foreground">
                  Download the MP4 from the meeting&apos;s Teams recap (or ask the organizer
                  for it), then drop it in the uploader on the home page. The full pipeline
                  works: speaker identification, playback, frames, video reports. Link this
                  calendar event to it after upload for auto-sharing.
                </p>
              </div>
              <div className="rounded-md border p-3 space-y-1">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  2. Upload the transcript file (fallback)
                </p>
                <p className="text-xs text-muted-foreground">
                  Export the transcript from the recap (docx or vtt) and use &quot;Import
                  transcript text&quot; — text-only import, no media features.
                </p>
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            </fieldset>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('pick')} disabled={busy}>
                <ChevronLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
              <Button
                disabled={blocked}
                title={blocked ? OFFLINE_TITLE : undefined}
                onClick={() => {
                  handleClose();
                  requestMediaUpload();
                }}
              >
                <Upload className="h-4 w-4 mr-1.5" />
                Upload the video
              </Button>
            </DialogFooter>
          </div>
        )}

        <fieldset disabled={blocked} className="contents">
        {step === 'options' && picked && (
          <div className="space-y-4 min-w-0">
            <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
              <p className="text-sm font-medium">{picked.event.summary ?? '(no title)'}</p>
              <p className="text-xs text-muted-foreground">{fmtEventRange(picked.event)}</p>
              {picked.event.conferenceData?.conferenceId && (
                <p className="text-xs text-muted-foreground font-mono">
                  meet.google.com/{picked.event.conferenceData.conferenceId}
                </p>
              )}
              {(picked.event.attendees ?? []).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">
                    {(picked.event.attendees ?? []).length} invitees:
                  </span>{' '}
                  {inviteeSummary(picked.event)}
                </p>
              )}
              <div className="pt-1 space-y-0.5">
                {/* Big loader ONLY when we know nothing at all yet. When the
                    poller cache (or the row) already told us what exists,
                    render it immediately — the live re-check happens behind a
                    one-line spinner instead of blanking the card. */}
                {picked.enriching &&
                !picked.videoFileId &&
                !picked.transcriptDocId &&
                !picked.cacheMeta ? (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Checking Drive and the Meet API for artifacts…
                  </p>
                ) : (
                  <>
                    {picked.videoFileId ? (
                      <p className="text-xs flex items-center gap-1">
                        <Video className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {picked.videoName ?? 'Recording'}
                          {picked.videoSize != null && (
                            <span className="text-muted-foreground">
                              {' '}
                              · {fmtBytes(picked.videoSize)}
                            </span>
                          )}
                          {picked.videoDurationMs != null && (
                            <span className="text-muted-foreground">
                              {' '}
                              · {fmtDurationMs(picked.videoDurationMs)}
                            </span>
                          )}
                          {picked.videoCount > 1 && (
                            <span className="text-muted-foreground">
                              {' '}
                              · {picked.videoCount} videos (stop-restart recording) — the
                              first is transcribed, the rest attach automatically
                            </span>
                          )}
                        </span>
                      </p>
                    ) : picked.enriching ? null : picked.videoPending ? (
                      <p className="text-xs text-amber-600 dark:text-amber-500 flex items-center gap-1">
                        <Video className="h-3 w-3 shrink-0" />
                        Recorded — Google is still preparing the video file.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">No recording found.</p>
                    )}
                    {picked.transcriptDocId ? (
                      <p className="text-xs flex items-center gap-1">
                        <FileText className="h-3 w-3 shrink-0" />
                        Meet transcript found
                        {picked.cacheMeta?.utteranceCount != null &&
                          picked.cacheMeta.utteranceCount > 0 && (
                            <span className="text-muted-foreground">
                              · {picked.cacheMeta.utteranceCount} turns
                              {picked.cacheMeta.wordCount != null &&
                                ` · ${picked.cacheMeta.wordCount.toLocaleString()} words`}
                              {picked.cacheMeta.speakerCount != null &&
                                ` · ${picked.cacheMeta.speakerCount} speaker${picked.cacheMeta.speakerCount === 1 ? '' : 's'}`}
                            </span>
                          )}
                        {picked.transcriptSource === 'meet-api' && (
                          <span className="text-muted-foreground">
                            (via Meet API — not on the calendar event)
                          </span>
                        )}
                        {picked.transcriptSource === 'gemini' && (
                          <span className="text-muted-foreground">
                            (Transcript tab of the Notes by Gemini doc)
                          </span>
                        )}
                      </p>
                    ) : picked.enriching ? null : picked.transcriptPending ? (
                      <p className="text-xs text-amber-600 dark:text-amber-500 flex items-center gap-1">
                        <FileText className="h-3 w-3 shrink-0" />
                        Transcribed — Google is still preparing the transcript Doc.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No Meet transcript found for this meeting.
                      </p>
                    )}
                    {picked.enriching && (
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        double-checking with Google…
                      </p>
                    )}
                    {picked.cacheMeta?.transcriptParseable === false && (
                      <p className="text-xs text-amber-600 dark:text-amber-500 flex items-start gap-1">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
                        <span>
                          Meet&apos;s transcript Doc looked empty or unparseable when we last
                          checked it — quick import will probably fail.
                          {picked.videoFileId
                            ? ' Re-transcribing the recording is pre-selected below.'
                            : ' There is no recording to fall back on for this meeting.'}
                        </span>
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      On import we also snapshot who actually joined (with join/leave times)
                      and Meet&apos;s own per-utterance transcript timings — they expire on
                      Google&apos;s side after 30 days.
                    </p>
                  </>
                )}
              </div>
            </div>

            {conflict && (
              <div className="rounded-md border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
                <p className="text-sm">
                  Already imported by{' '}
                  {conflict.own ? 'you' : (conflict.ownerEmail ?? 'a teammate')}
                  {conflict.title ? (
                    <>
                      {' '}
                      — <span className="font-medium">{conflict.title}</span>
                    </>
                  ) : null}
                  {conflict.accessible === false
                    ? ". It hasn't been shared with you — but if you were in the meeting (or its files are shared with you), you can join their import instead of making a duplicate."
                    : ". It's in your list (invitees are shared in automatically)."}
                </p>
                <div className="flex gap-2 flex-wrap">
                  {conflict.id && (
                    <a href={`/transcript/${conflict.id}`}>
                      <Button size="sm">
                        <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                        Open transcript
                      </Button>
                    </a>
                  )}
                  {conflict.accessible === false &&
                    picked.event.conferenceData?.conferenceId && (
                      <Button size="sm" onClick={() => void joinExisting()} disabled={busy}>
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                        )}
                        Join their import
                      </Button>
                    )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runImport(true)}
                    disabled={busy}
                  >
                    {conflict.own ? 'Re-import (overwrites yours)' : 'Import my own copy anyway'}
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {(picked.transcriptDocId || picked.transcriptPending) && (
                <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer has-[:checked]:border-primary">
                  <input
                    type="radio"
                    name="gmeet-mode"
                    checked={mode === 'transcript'}
                    onChange={() => {
                      modeTouchedRef.current = true;
                      setMode('transcript');
                    }}
                    className="mt-0.5"
                  />
                  <span className="text-sm">
                    <span className="font-medium">
                      Quick import Meet&apos;s transcript (recommended)
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Instant and free, with real participant names. Caveat: people sharing
                      one meeting-room mic show up as one speaker, and there&apos;s no audio
                      playback — you can always re-run diarization later if that matters.
                    </span>
                    {!picked.transcriptDocId && picked.transcriptPending && (
                      <span className="block text-xs text-amber-600 dark:text-amber-500">
                        Doc still being prepared — importing now queues it and it runs
                        automatically when the Doc is ready (usually minutes).
                      </span>
                    )}
                  </span>
                </label>
              )}
              {(picked.videoFileId || picked.videoPending) &&
                (picked.transcriptDocId || picked.transcriptPending) && (
                  <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer has-[:checked]:border-primary">
                    <input
                      type="radio"
                      name="gmeet-mode"
                      checked={mode === 'both'}
                      onChange={() => {
                        modeTouchedRef.current = true;
                        setMode('both');
                      }}
                      className="mt-0.5"
                    />
                    <span className="text-sm">
                      <span className="font-medium">Re-transcribe + keep Meet transcript</span>
                      <span className="block text-xs text-muted-foreground">
                        For when speaker separation matters (pooled meeting-room audio):
                        voice-level diarization from the video, with Google&apos;s transcript
                        kept alongside for names. Slower, uses transcription credit.
                      </span>
                      {(!picked.videoFileId || !picked.transcriptDocId) &&
                        (picked.videoPending || picked.transcriptPending) && (
                          <span className="block text-xs text-amber-600 dark:text-amber-500">
                            Waits for both the video and the transcript Doc — importing now
                            queues it and it runs automatically when they&apos;re ready.
                          </span>
                        )}
                    </span>
                  </label>
                )}
              {(picked.videoFileId || picked.videoPending) && (
                <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer has-[:checked]:border-primary">
                  <input
                    type="radio"
                    name="gmeet-mode"
                    checked={mode === 'video'}
                    onChange={() => {
                      modeTouchedRef.current = true;
                      setMode('video');
                    }}
                    className="mt-0.5"
                  />
                  <span className="text-sm">
                    <span className="font-medium">Re-transcribe the recording only</span>
                    <span className="block text-xs text-muted-foreground">
                      Exception path: fetch the video from Drive and run our transcription
                      with speaker diarization. Takes a few minutes.
                    </span>
                    {!picked.videoFileId && picked.videoPending && (
                      <span className="block text-xs text-amber-600 dark:text-amber-500">
                        Video still being prepared — importing now queues it and it runs
                        automatically when the file is ready (longer for long recordings).
                      </span>
                    )}
                  </span>
                </label>
              )}
              {!picked.enriching &&
                !picked.videoFileId &&
                !picked.transcriptDocId &&
                (picked.videoPending || picked.transcriptPending ? (
                  <div className="rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
                    <p className="text-sm">
                      This meeting was{' '}
                      {picked.videoPending && picked.transcriptPending
                        ? 'recorded and transcribed'
                        : picked.videoPending
                          ? 'recorded'
                          : 'transcribed'}{' '}
                      — Google is still preparing the{' '}
                      {picked.videoPending && picked.transcriptPending
                        ? 'files'
                        : picked.videoPending
                          ? 'video file'
                          : 'transcript Doc'}
                      . This usually takes a few minutes after the call ends (longer for long
                      recordings). You can import anyway — it queues and runs automatically
                      the moment Google finishes — or check again now.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        const next = { ...picked, enriching: true };
                        setPicked(next);
                        void enrich(next);
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      Check again
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground p-1">
                    Nothing importable found for this meeting — it may not have been recorded,
                    or Meet is still processing the artifacts.
                  </p>
                ))}
            </div>

            {error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )}
          </div>
        )}

        {step === 'importing' && (
          <div className="py-8 text-center">
            <Download className="h-10 w-10 animate-bounce mx-auto text-primary" />
            <p className="mt-3 text-sm text-muted-foreground">
              {mode === 'transcript'
                ? 'Importing the transcript…'
                : 'Starting the import — checking the artifacts and handing the download to the server… a few seconds.'}
            </p>
          </div>
        )}

        {step === 'done' && doneInfo && (
          <div className="py-6 text-center space-y-2">
            {doneInfo.deferred ? (
              <Loader2 className="h-10 w-10 mx-auto animate-spin text-amber-500" />
            ) : (
              <CheckCircle2 className="h-10 w-10 mx-auto text-status-ok" />
            )}
            <p className="text-sm font-medium">{doneInfo.title}</p>
            <p className="text-sm text-muted-foreground">
              {doneInfo.background
                ? 'Import running in the background — the server is pulling the recording and submitting it for transcription. It shows in your list right away and completes on its own; nothing else to do here.'
                : doneInfo.deferred
                ? `Import queued — ${doneInfo.teams ? 'Microsoft' : 'Google'} is still preparing the ${
                    doneInfo.deferred === 'both'
                      ? 'video and transcript'
                      : doneInfo.deferred === 'video'
                        ? 'video file'
                        : doneInfo.teams
                          ? 'transcript'
                          : 'transcript Doc'
                  }. It's in your list as waiting; we check every minute and the import runs by itself the moment the file${doneInfo.deferred === 'both' ? 's are' : ' is'} ready. Nothing else to do — you can close this.`
                : doneInfo.mode === 'transcript'
                  ? `${doneInfo.teams ? 'Teams' : 'Meet'} transcript imported — it’s ready in your list now.`
                  : 'Recording submitted for transcription — it’ll show up in your list as processing and complete in a few minutes.'}
            </p>
            {doneInfo.autoShared > 0 && (
              <p className="text-xs text-muted-foreground">
                Auto-shared with {doneInfo.autoShared} Trames colleague
                {doneInfo.autoShared === 1 ? '' : 's'} who {doneInfo.autoShared === 1 ? 'was' : 'were'} in the meeting.
              </p>
            )}
          </div>
        )}

        </fieldset>

        <DialogFooter>
          {step === 'connect' && connectPitch && (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={connect} disabled={busy || blocked} title={blocked ? OFFLINE_TITLE : undefined}>
                {busy ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Video className="h-4 w-4 mr-2" />
                )}
                Connect Google
              </Button>
            </>
          )}
          {step === 'pick' && (
            <>
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              {selected.size > 0 && (
                <Button onClick={() => void runBulkImport()} disabled={busy || blocked} title={blocked ? OFFLINE_TITLE : undefined}>
                  <Download className="h-4 w-4 mr-2" />
                  Quick-import {selected.size} transcript{selected.size === 1 ? '' : 's'}
                </Button>
              )}
            </>
          )}
          {step === 'bulk' && (
            <Button onClick={handleClose} disabled={busy}>
              Done
            </Button>
          )}
          {step === 'options' && (
            <>
              <Button variant="ghost" onClick={() => setStep('pick')} disabled={busy}>
                Back
              </Button>
              <Button
                onClick={() => runImport()}
                title={blocked ? OFFLINE_TITLE : undefined}
                disabled={
                  // Enriching alone doesn't block: once ANY artifact id is
                  // known (poller cache or calendar row), importing is safe —
                  // the server re-resolves everything authoritatively anyway.
                  // Pending artifacts count too: the server queues the import
                  // (defer) and runs it when Google finishes the file.
                  blocked ||
                  busy ||
                  (!picked?.videoFileId &&
                    !picked?.transcriptDocId &&
                    !picked?.videoPending &&
                    !picked?.transcriptPending) ||
                  !!conflict
                }
              >
                <Download className="h-4 w-4 mr-2" />
                Import
              </Button>
            </>
          )}
          {step === 'done' && <Button onClick={handleClose}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
