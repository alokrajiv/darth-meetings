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
  Video,
} from 'lucide-react';

const MEET_API = 'https://meet.googleapis.com/v2';

interface CalendarAttachment {
  fileId?: string;
  title?: string;
  mimeType?: string;
}

interface CalendarEvent {
  id: string;
  summary?: string;
  /** Series key for recurring events — sturdier identity than the meeting
   * code (people recycle Meet links across unrelated meetings). */
  recurringEventId?: string;
  iCalUID?: string;
  organizer?: { email?: string; self?: boolean };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
  }>;
  attachments?: CalendarAttachment[];
  conferenceData?: { conferenceId?: string };
}

/** Meet API artifact info attached to a row by the day sweep / record pick. */
interface MeetRowInfo {
  recordName: string;
  videoFileId: string | null;
  transcriptDocId: string | null;
  /** Artifact exists on the record but Google hasn't finished the file yet. */
  videoPending: boolean;
  transcriptPending: boolean;
  /** null = not checked yet (recents rows — resolved on pick) */
  checked: boolean;
}

interface EventRow {
  event: CalendarEvent;
  video: CalendarAttachment | null;
  transcriptDoc: CalendarAttachment | null;
  geminiNotes: CalendarAttachment | null;
  videoCount: number;
  meet: MeetRowInfo | null;
  /** conference record with no matching calendar event (orphan) */
  offCalendar?: boolean;
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
type Step = 'connect' | 'pick' | 'options' | 'importing' | 'done' | 'bulk';
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

/** Poller-cached meeting metadata from /api/gmeet/check — display-only
 * enrichment (badges, instant options step). Access is still proven through
 * the user's own token at import time. */
interface MeetingMeta {
  conferenceRecord: string | null;
  confStart: string | null;
  confEnd: string | null;
  recordingCount: number;
  videoFileId: string | null;
  videoSize: number | null;
  videoDurationMs: number | null;
  transcriptDocIds: string[] | null;
  transcriptParseable: boolean | null;
  utteranceCount: number | null;
  wordCount: number | null;
  speakerCount: number | null;
}

interface SyncInfo {
  lastSyncedAt: string | null;
  skips: Set<string>;
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

function classifyAttachments(atts: CalendarAttachment[] | undefined): {
  video: CalendarAttachment | null;
  transcriptDoc: CalendarAttachment | null;
  geminiNotes: CalendarAttachment | null;
  videoCount: number;
} {
  let video: CalendarAttachment | null = null;
  let transcriptDoc: CalendarAttachment | null = null;
  let geminiNotes: CalendarAttachment | null = null;
  let videoCount = 0;
  for (const a of atts ?? []) {
    if (!a.fileId) continue;
    if (a.mimeType?.startsWith('video/')) {
      videoCount++;
      if (!video) video = a;
    } else if (a.mimeType === 'application/vnd.google-apps.document') {
      if (/gemini/i.test(a.title ?? '')) {
        if (!geminiNotes) geminiNotes = a;
      } else if (/transcript/i.test(a.title ?? '')) {
        if (!transcriptDoc) transcriptDoc = a;
      }
    }
  }
  return { video, transcriptDoc, geminiNotes, videoCount };
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

async function fetchDriveMeta(
  token: string,
  fileId: string
): Promise<{ name: string; size: number | null; durationMs: number | null } | null> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent('name,size,videoMediaMetadata(durationMillis)')}&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      name?: string;
      size?: string;
      videoMediaMetadata?: { durationMillis?: string };
    };
    return {
      name: j.name ?? 'recording',
      size: j.size != null ? Number(j.size) : null,
      durationMs:
        j.videoMediaMetadata?.durationMillis != null
          ? Number(j.videoMediaMetadata.durationMillis)
          : null,
    };
  } catch {
    return null;
  }
}

/** 5400000 → "1 h 30 m"; 240000 → "4 min". */
function fmtDurationMs(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} h ${m} m` : `${h} h`;
}

interface MeetRecordLite {
  name: string;
  startTime?: string;
  endTime?: string;
  spaceResource?: string;
}

/** List conference records matching a filter (the caller's own meetings). */
async function listMeetRecords(
  token: string,
  filterExpr: string,
  pageLimit = 3
): Promise<MeetRecordLite[]> {
  const out: MeetRecordLite[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < pageLimit; i++) {
    const res = await fetch(
      `${MEET_API}/conferenceRecords?filter=${encodeURIComponent(filterExpr)}&pageSize=50${pageToken ? `&pageToken=${pageToken}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      // THROW, don't return partial: callers must distinguish "no records"
      // (meeting never happened) from "couldn't check" (scope/quota) — a
      // silent empty result greys out real meetings as "never started".
      const detail = await res.text().catch(() => '');
      console.debug('[gmeet-import] conferenceRecords list failed', res.status, detail);
      throw new Error(`Meet API list failed (${res.status})`);
    }
    const j = (await res.json()) as {
      conferenceRecords?: Array<{ name: string; startTime?: string; endTime?: string; space?: string }>;
      nextPageToken?: string;
    };
    for (const r of j.conferenceRecords ?? []) {
      out.push({ name: r.name, startTime: r.startTime, endTime: r.endTime, spaceResource: r.space });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/** Resolve a record's space resource to its human meeting code. */
async function fetchMeetingCode(token: string, spaceResource: string): Promise<string | null> {
  try {
    const res = await fetch(`${MEET_API}/${spaceResource}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { meetingCode?: string };
    return j.meetingCode ?? null;
  } catch {
    return null;
  }
}

/** Fetch a record's recording + transcript artifact ids.
 *
 * Artifacts appear in these lists BEFORE their files exist: right after a
 * call ends the entry is there with `state: "ENDED"` and an empty
 * driveDestination/docsDestination, flipping to `FILE_GENERATED` with the id
 * populated once Google finishes processing. The pending flags carry that
 * "recorded, still being prepared" state — without them a just-ended meeting
 * reads as "never recorded". */
async function recordArtifacts(
  token: string,
  recordName: string
): Promise<{
  videoFileId: string | null;
  transcriptDocId: string | null;
  videoPending: boolean;
  transcriptPending: boolean;
}> {
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const [recRes, transRes] = await Promise.all([
    fetch(`${MEET_API}/${recordName}/recordings`, auth),
    fetch(`${MEET_API}/${recordName}/transcripts`, auth),
  ]);
  const recs = recRes.ok
    ? ((await recRes.json()) as {
        recordings?: Array<{ state?: string; driveDestination?: { file?: string } }>;
      })
    : {};
  const trans = transRes.ok
    ? ((await transRes.json()) as {
        transcripts?: Array<{ state?: string; docsDestination?: { document?: string } }>;
      })
    : {};
  const recordings = recs.recordings ?? [];
  const transcripts = trans.transcripts ?? [];
  return {
    videoFileId: recordings.find((r) => r.driveDestination?.file)?.driveDestination?.file ?? null,
    transcriptDocId:
      transcripts.find((t) => t.docsDestination?.document)?.docsDestination?.document ?? null,
    videoPending: recordings.length > 0 && !recordings.some((r) => r.driveDestination?.file),
    transcriptPending:
      transcripts.length > 0 && !transcripts.some((t) => t.docsDestination?.document),
  };
}

/**
 * "Import from Meet": connect Google → pick a meeting (from the calendar day
 * view, the last-30-days Meet history, or a pasted Meet link) → the options
 * step enriches it (Drive metadata + Meet API artifacts) → choose how to
 * import → run. All Google reads happen in the browser with the user's
 * short-lived token; only the import call goes through our server.
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
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState<string>(todayLocalISO());
  const [rows, setRows] = useState<EventRow[]>([]);
  const [paste, setPaste] = useState('');
  const [picked, setPicked] = useState<PickedMeeting | null>(null);
  const [mode, setMode] = useState<Mode>('both');
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ mode: Mode; title: string; autoShared: number } | null>(null);
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

  /** Mute key: meeting code when there is one, else the calendar event id. */
  const rowKey = (row: EventRow): string =>
    row.event.conferenceData?.conferenceId ?? row.event.id;

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
    } catch {
      // optimistic; worst case the mute doesn't stick
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
    } catch {
      // ignore
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
    } catch {
      // non-fatal
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
      const token = await getGoogleAccessToken();

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

      // 2. Calendar events over the window.
      const params = new URLSearchParams({
        timeMin: fromIso,
        timeMax: new Date().toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        fields:
          'items(id,summary,recurringEventId,iCalUID,organizer(email,self),start,end,attendees(email,displayName,responseStatus,self),attachments(fileId,title,mimeType),conferenceData(conferenceId))',
      });
      const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (calRes.status === 401) {
        invalidateGoogleToken();
        throw new Error('Google session expired — hit Connect again.');
      }
      if (!calRes.ok) throw new Error(`Calendar request failed (${calRes.status})`);
      const calData = (await calRes.json()) as { items?: CalendarEvent[] };
      const evRows: EventRow[] = (calData.items ?? [])
        .filter((e) => e.start?.dateTime && e.conferenceData?.conferenceId)
        .map((event) => ({ event, ...classifyAttachments(event.attachments), meet: null }));

      // 3. Conference records over the window (proves which meetings actually
      // happened + finds their artifacts), joined by exact meeting code.
      try {
        const records = await listMeetRecords(token, `start_time >= "${fromIso}"`, 3);
        const enriched = await Promise.all(
          records.map(async (r) => {
            const [code, artifacts] = await Promise.all([
              r.spaceResource
                ? fetchMeetingCode(token, r.spaceResource)
                : Promise.resolve(null),
              recordArtifacts(token, r.name),
            ]);
            return { ...r, code, ...artifacts };
          })
        );
        const extras: EventRow[] = [];
        for (const rec of enriched) {
          const info: MeetRowInfo = {
            recordName: rec.name,
            videoFileId: rec.videoFileId,
            transcriptDocId: rec.transcriptDocId,
            videoPending: rec.videoPending,
            transcriptPending: rec.transcriptPending,
            checked: true,
          };
          const target = rec.code
            ? evRows.find((row) => row.event.conferenceData?.conferenceId === rec.code)
            : undefined;
          if (target) {
            target.meet = target.meet ?? info;
          } else {
            extras.push({
              event: {
                id: rec.name,
                summary: `Meet${rec.code ? ` · ${rec.code}` : ''} (not on calendar)`,
                start: { dateTime: rec.startTime },
                end: { dateTime: rec.endTime },
                conferenceData: rec.code ? { conferenceId: rec.code } : undefined,
                attendees: [],
              },
              video: null,
              transcriptDoc: null,
              geminiNotes: null,
              videoCount: 0,
              meet: info,
              offCalendar: true,
            });
          }
        }
        evRows.push(...extras);
        setSweepDone(true);
      } catch (err) {
        console.debug('[gmeet-import] sync sweep failed', err);
        setSweepDone(false);
      }

      evRows.sort((a, b) =>
        (b.event.start?.dateTime ?? '').localeCompare(a.event.start?.dateTime ?? '')
      );
      setSelected(new Set());
      setRows(evRows);
      setStep('pick');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sync view');
      if (!hasValidGoogleToken()) {
        setStep('connect');
        setConnectPitch(true);
      }
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
   * Day sweep: one Meet API listing for the day joins actual conferences to
   * the calendar rows (accurate badges even when nothing is attached to the
   * event), and surfaces meetings you joined that aren't on your calendar.
   */
  const sweepDay = useCallback(async (forDate: string, token: string) => {
    try {
      const lo = new Date(`${forDate}T00:00:00`).toISOString();
      const hi = new Date(`${forDate}T23:59:59.999`).toISOString();
      const records = await listMeetRecords(
        token,
        `start_time >= "${lo}" AND start_time <= "${hi}"`,
        2
      );
      if (records.length === 0) {
        setSweepDone(true);
        return;
      }

      const enriched = await Promise.all(
        records.map(async (r) => {
          const [code, artifacts] = await Promise.all([
            r.spaceResource ? fetchMeetingCode(token, r.spaceResource) : Promise.resolve(null),
            recordArtifacts(token, r.name),
          ]);
          return { ...r, code, ...artifacts };
        })
      );
      console.debug('[gmeet-import] day sweep', forDate, enriched);

      setRows((prev) => {
        const next = prev.map((row) => ({ ...row }));
        const extras: EventRow[] = [];
        for (const rec of enriched) {
          const info: MeetRowInfo = {
            recordName: rec.name,
            videoFileId: rec.videoFileId,
            transcriptDocId: rec.transcriptDocId,
            videoPending: rec.videoPending,
            transcriptPending: rec.transcriptPending,
            checked: true,
          };
          // Join ONLY by exact meeting code. No time-overlap guessing: a
          // moved calendar event once matched a neighbouring slot's record
          // and imported a completely different meeting's transcript.
          const target = rec.code
            ? next.find((row) => row.event.conferenceData?.conferenceId === rec.code)
            : undefined;
          if (target) {
            // Keep the earliest-found artifacts; Meet API fills gaps.
            target.meet = target.meet ?? info;
          } else {
            extras.push({
              event: {
                id: rec.name,
                summary: `Meet${rec.code ? ` · ${rec.code}` : ''} (not on calendar)`,
                start: { dateTime: rec.startTime },
                end: { dateTime: rec.endTime },
                conferenceData: rec.code ? { conferenceId: rec.code } : undefined,
                attendees: [],
              },
              video: null,
              transcriptDoc: null,
              geminiNotes: null,
              videoCount: 0,
              meet: info,
              offCalendar: true,
            });
          }
        }
        return [...next, ...extras];
      });
      setSweepDone(true);
    } catch (err) {
      // Sweep unavailable (scope/API not granted) — stay permissive, don't
      // grey rows we can't actually verify.
      console.debug('[gmeet-import] day sweep failed', err);
    }
  }, []);

  const loadEvents = useCallback(
    async (forDate: string) => {
      setBusy(true);
      setError(null);
      setTab('calendar');
      try {
        const token = await getGoogleAccessToken();
        const params = new URLSearchParams({
          timeMin: new Date(`${forDate}T00:00:00`).toISOString(),
          timeMax: new Date(`${forDate}T23:59:59.999`).toISOString(),
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '50',
          fields:
            'items(id,summary,recurringEventId,iCalUID,organizer(email,self),start,end,attendees(email,displayName,responseStatus,self),attachments(fileId,title,mimeType),conferenceData(conferenceId))',
        });
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (res.status === 401) {
          invalidateGoogleToken();
          throw new Error('Google session expired — hit Connect again.');
        }
        if (!res.ok) throw new Error(`Calendar request failed (${res.status})`);
        const data = (await res.json()) as { items?: CalendarEvent[] };
        console.debug('[gmeet-import] events for', forDate, data.items);
        const evRows: EventRow[] = (data.items ?? [])
          // Meetings only — skip all-day events (no dateTime).
          .filter((e) => e.start?.dateTime)
          .map((event) => ({ event, ...classifyAttachments(event.attachments), meet: null }));
        setSweepDone(false);
        setSelected(new Set());
        setRows(evRows);
        setStep('pick');
        // Non-blocking: join the day's actual conferences in when they load.
        void sweepDay(forDate, token);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load calendar');
        if (!hasValidGoogleToken()) {
          setStep('connect');
          setConnectPitch(true);
        }
      } finally {
        setBusy(false);
      }
    },
    [sweepDay]
  );

  /** Last 30 days of conferences the user was in (Meet API only, no titles). */
  const loadRecents = useCallback(async () => {
    setBusy(true);
    setError(null);
    setTab('recent');
    try {
      const token = await getGoogleAccessToken();
      const lo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const records = await listMeetRecords(token, `start_time >= "${lo}"`, 3);
      records.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
      setSelected(new Set());
      setRows(
        records.map((r) => ({
          event: {
            id: r.name,
            summary: `Meet — ${fmtDayTime(r.startTime)}`,
            start: { dateTime: r.startTime },
            end: { dateTime: r.endTime },
            attendees: [],
          },
          video: null,
          transcriptDoc: null,
          geminiNotes: null,
          videoCount: 0,
          meet: {
            recordName: r.name,
            videoFileId: null,
            transcriptDocId: null,
            videoPending: false,
            transcriptPending: false,
            checked: false,
          },
          offCalendar: true,
        }))
      );
      setStep('pick');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recent meets');
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
      const token = await getGoogleAccessToken();
      const records = await listMeetRecords(token, `space.meeting_code = "${code}"`, 2);
      records.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
      if (records.length === 0) {
        setError(
          `No conference records found for ${code} — the Meet API only shows meetings you attended or organised.`
        );
        return;
      }
      setSelected(new Set());
      setRows(
        records.map((r) => ({
          event: {
            id: r.name,
            summary: `${code} — ${fmtDayTime(r.startTime)}`,
            start: { dateTime: r.startTime },
            end: { dateTime: r.endTime },
            conferenceData: { conferenceId: code },
            attendees: [],
          },
          video: null,
          transcriptDoc: null,
          geminiNotes: null,
          videoCount: 0,
          meet: {
            recordName: r.name,
            videoFileId: null,
            transcriptDocId: null,
            videoPending: false,
            transcriptPending: false,
            checked: false,
          },
          offCalendar: true,
        }))
      );
    } catch (err) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Scroll the focused meeting into view once its row shows up.
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
    }
  }, [open, rows, focusMeeting]);

  const changeDate = (next: string) => {
    setDate(next);
    void loadEvents(next);
  };

  /** Merge Drive metadata + Meet API artifacts into the picked meeting. */
  const enrich = async (initial: PickedMeeting) => {
    try {
      const token = await getGoogleAccessToken();
      const e = initial.event;
      let recordName = initial.conferenceRecordName;
      let videoFileId = initial.videoFileId;
      let transcriptDocId = initial.transcriptDocId;
      let transcriptSource = initial.transcriptSource;
      let videoPending = initial.videoPending;
      let transcriptPending = initial.transcriptPending;

      // Find the conference record if we don't have it yet. The API returns
      // records NEWEST-first — always pick the one NEAREST the event start,
      // never [0], or a reused standing link imports the wrong meeting.
      if (!recordName && e.conferenceData?.conferenceId) {
        let filter = `space.meeting_code = "${e.conferenceData.conferenceId}"`;
        if (e.start?.dateTime) {
          const t = new Date(e.start.dateTime).getTime();
          filter += ` AND start_time >= "${new Date(t - 6 * 3600_000).toISOString()}" AND start_time <= "${new Date(t + 12 * 3600_000).toISOString()}"`;
        }
        const records = await listMeetRecords(token, filter, 1);
        if (records.length > 0) {
          const target = e.start?.dateTime ? new Date(e.start.dateTime).getTime() : null;
          if (target != null) {
            records.sort(
              (a, b) =>
                Math.abs(new Date(a.startTime ?? 0).getTime() - target) -
                Math.abs(new Date(b.startTime ?? 0).getTime() - target)
            );
          }
          recordName = records[0]!.name;
        }
      }

      // Fill artifact gaps from the record.
      if (recordName && (!videoFileId || !transcriptDocId)) {
        const found = await recordArtifacts(token, recordName);
        if (!videoFileId && found.videoFileId) videoFileId = found.videoFileId;
        if (!transcriptDocId && found.transcriptDocId) {
          transcriptDocId = found.transcriptDocId;
          transcriptSource = 'meet-api';
        }
        // Live check is authoritative for the pending state either way —
        // this is also how a re-check clears a stale "still preparing".
        videoPending = found.videoPending;
        transcriptPending = found.transcriptPending;
      }

      let videoName: string | null = null;
      let videoSize: number | null = null;
      let videoDurationMs: number | null = null;
      if (videoFileId) {
        const meta = await fetchDriveMeta(token, videoFileId);
        if (meta) {
          videoName = meta.name;
          videoSize = meta.size;
          videoDurationMs = meta.durationMs;
        }
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
          videoName: videoName ?? prev.videoName,
          videoSize: videoSize ?? prev.videoSize,
          videoDurationMs: videoDurationMs ?? prev.videoDurationMs,
          transcriptDocId: transcriptDocId ?? prev.transcriptDocId,
          transcriptSource: transcriptSource ?? prev.transcriptSource,
          videoPending: !(videoFileId ?? prev.videoFileId) && videoPending,
          transcriptPending: !(transcriptDocId ?? prev.transcriptDocId) && transcriptPending,
          enriching: false,
        };
      });
      // Transcript-first default — but only for the row that's still picked,
      // and never over a choice the user already made by hand.
      if (applied && !modeTouchedRef.current) {
        const docKnownBad = initial.cacheMeta?.transcriptParseable === false;
        setMode(
          transcriptDocId && !docKnownBad
            ? 'transcript'
            : videoFileId
              ? 'video'
              : 'transcript'
        );
      }
    } catch {
      setPicked((prev) =>
        prev && prev.event.id === initial.event.id ? { ...prev, enriching: false } : prev
      );
    }
  };

  const pickEvent = (row: EventRow) => {
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
    const docKnownBad = cached?.transcriptParseable === false;
    setMode(
      transcriptDocId && !docKnownBad ? 'transcript' : videoFileId ? 'video' : 'transcript'
    );
    setStep('options');
    void enrich(initial);
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
      const title = e.summary ?? '(no title)';
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

      const payload = (await res.json()) as { autoShared?: number };
      setDoneInfo({
        mode,
        title: e.summary ?? 'Untitled meeting',
        autoShared: payload.autoShared ?? 0,
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
          <DialogTitle className="text-base font-semibold">Import from Google Meet</DialogTitle>
        </DialogHeader>

        {step === 'connect' && !connectPitch && (
          <div className="py-10 text-center">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">Loading your meetings…</p>
          </div>
        )}

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
                    const mark = key ? importedMap[key] : undefined;
                    const meta = key ? metaMap[key] : undefined;
                    const hasVideo = !!(
                      row.video ||
                      row.meet?.videoFileId ||
                      (meta?.recordingCount ?? 0) > 0
                    );
                    const hasTranscript = !!(
                      row.transcriptDoc ||
                      row.meet?.transcriptDocId ||
                      row.geminiNotes ||
                      meta?.transcriptDocIds?.length
                    );
                    // Recorded/transcribed, but Google is still generating the
                    // files (state ENDED, no Drive file / Doc id yet).
                    const preparing =
                      (!hasVideo && !!row.meet?.videoPending) ||
                      (!hasTranscript && !!row.meet?.transcriptPending);
                    // Artifacts inventoried (Meet API sweep or poller cache)
                    // and none found → the meeting ran but produced nothing
                    // importable. Don't invite a doomed click.
                    const checkedEmpty =
                      !!row.meet?.checked && !hasVideo && !hasTranscript && !preparing;
                    // Before the day sweep confirms which meetings actually
                    // happened, a Meet link is enough to try; after it, a
                    // link with no conference record = never started.
                    const importable =
                      !checkedEmpty &&
                      (hasVideo ||
                        hasTranscript ||
                        !!row.meet ||
                        (!sweepDone && !!row.event.conferenceData?.conferenceId));
                    const muted = !!syncInfo?.skips.has(rowKey(row));
                    const focused =
                      !!focusMeeting?.meetingCode &&
                      row.event.conferenceData?.conferenceId === focusMeeting.meetingCode;
                    return (
                      <li
                        key={row.event.id}
                        id={focused ? 'gmeet-focus-row' : undefined}
                        className={`flex items-center ${muted ? 'opacity-45' : ''} ${
                          focused ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''
                        }`}
                      >
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
                              tab === 'sync' ? 'w-24' : 'w-16'
                            }`}
                          >
                            {tab === 'calendar'
                              ? fmtEventTime(row.event)
                              : tab === 'sync'
                                ? fmtDayTime(row.event.start?.dateTime)
                                : ''}
                          </span>
                          <span className="flex-1 min-w-0 truncate text-sm">
                            {row.event.summary ?? '(no title)'}
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
                              {checkedEmpty
                                ? 'nothing to import'
                                : row.event.conferenceData?.conferenceId
                                  ? 'never started'
                                  : 'no meet link'}
                            </span>
                          )}
                        </button>
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
                              · {picked.videoCount} recordings, importing the first
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
              {picked.transcriptDocId && (
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
                  </span>
                </label>
              )}
              {picked.videoFileId && picked.transcriptDocId && (
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
                  </span>
                </label>
              )}
              {picked.videoFileId && (
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
                      recordings).
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
                ? 'Importing the Meet transcript…'
                : 'Pulling the recording from Drive and submitting for transcription… this can take a few minutes for long meetings. Keep this tab open.'}
            </p>
          </div>
        )}

        {step === 'done' && doneInfo && (
          <div className="py-6 text-center space-y-2">
            <CheckCircle2 className="h-10 w-10 mx-auto text-status-ok" />
            <p className="text-sm font-medium">{doneInfo.title}</p>
            <p className="text-sm text-muted-foreground">
              {doneInfo.mode === 'transcript'
                ? 'Meet transcript imported — it’s ready in your list now.'
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

        <DialogFooter>
          {step === 'connect' && connectPitch && (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={connect} disabled={busy}>
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
                <Button onClick={() => void runBulkImport()} disabled={busy}>
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
                disabled={
                  // Enriching alone doesn't block: once ANY artifact id is
                  // known (poller cache or calendar row), importing is safe —
                  // the server re-resolves everything authoritatively anyway.
                  busy ||
                  (!picked?.videoFileId && !picked?.transcriptDocId) ||
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
