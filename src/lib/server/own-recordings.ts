import 'server-only';
import { listPendingVisibleToUser } from '@/db-ops/transcripts';
import {
  hydrateOwnMeetingRows,
  linkedMeetingsForOwnRecordings,
  listOwnRecordingsPage,
  ownRegistryRowsByIds,
  type LinkedMeetingRef,
  type PageKey,
} from '@/db-ops/own-recordings-page';
import { getStandaloneViewsForOwner, standaloneColumnsExist } from '@/db-ops/standalone-recordings';
import type { TranscriptListRow } from '@/lib/format';
import { refreshPendingAgainstAai } from '@/lib/server/aai-pending-refresh';
import { ownView, type OwnRecordingView } from '@/lib/server/recorder-view';
import { recordingViewOf, type RecordingView } from '@/lib/server/recording-actions';
import { refreshBornBare } from '@/lib/server/born-bare';
import {
  encodeRecordingsCursor,
  parseRecordingsPageQuery,
  type RecordingSection,
  type RecordingSectionCounts,
  type RecordingsPageQuery,
} from '@/lib/recordings-page';

/**
 * The Recordings surface's endpoint — `GET /api/recordings?mine=1`
 * (docs/recordings-meetings-series-design.md §3.1/§4.1, P6; paginated and
 * extended with born-bare recordings in P7, owner decision 2026-09-23).
 *
 * ONE newest-first, cursor-paginated list over three owner-scoped sources
 * (lib/recordings-page.ts, db-ops/own-recordings-page.ts):
 *   - `recording` — standalone recordings (P7) no live meeting holds;
 *   - `meeting`   — legacy bare uploads and legacy temporary rows (the
 *                   `transcripts` rows the P6 tabs showed), until they are
 *                   linked, trashed or expire;
 *   - `registry`  — Darth Recorder rows still on a Mac.
 * Plus, only when asked for by name (`section=linked`, 2026-10-02): the
 * caller's standalone recordings a live meeting holds, each with the
 * meetings it is in — kind `recording`, section `linked`, `meetings: [...]`.
 * No day window: the P6 version took the legacy halves from the meetings
 * listing's newest 60 days / ~200 rows, so older recordings silently
 * vanished. Per-section counts ride on every page.
 *
 * STRICTLY THE CALLER'S OWN (invariant I2): every source is asked with its
 * owner predicate in SQL, every hydration re-asks it, and `foldOwnPage`
 * drops anything whose owner is not the caller — the belt on the braces.
 */

/** A meeting a linked recording is in — one the caller can open. */
export interface LinkedMeeting {
  assemblyai_id: string;
  title: string | null;
  recorded_at: string | null;
}

export type RecordingsPageItem =
  | {
      kind: 'recording';
      section: RecordingSection;
      sort_us: string;
      recording: RecordingView;
      /** Section 'linked' only: the live meetings holding it that the caller can open. */
      meetings?: LinkedMeeting[];
    }
  | {
      kind: 'meeting';
      section: RecordingSection;
      sort_us: string;
      row: TranscriptListRow;
      /** The Darth Recorder row these bytes came from, when it is the caller's. */
      registry: OwnRecordingView | null;
    }
  | { kind: 'registry'; section: 'mac'; sort_us: string; registry: OwnRecordingView };

export interface OwnRecordingsResponse {
  items: RecordingsPageItem[];
  /** Pass back as `?cursor=` for the next page; null = that was the last. */
  next_cursor: string | null;
  /** Per section, over the whole set (search applied, cursor not). */
  counts: RecordingSectionCounts;
}

export { parseRecordingsPageQuery };

/**
 * The fold, pure: keeps only what the caller OWNS, in page order. Exported
 * for the tests, which hand it other people's rows on purpose.
 */
export function foldOwnPage(
  callerUserId: string,
  keys: PageKey[],
  hydrated: {
    recordings: RecordingView[];
    recordingOwners: Map<string, string>;
    meetings: TranscriptListRow[];
    registry: Array<{ user_id: string; view: OwnRecordingView }>;
    /** The 'linked' section's meetings, by recording id. */
    linkedMeetings?: Map<string, LinkedMeeting[]>;
  }
): RecordingsPageItem[] {
  const recs = new Map(
    hydrated.recordings
      .filter((r) => hydrated.recordingOwners.get(r.id) === callerUserId)
      .map((r) => [r.id, r])
  );
  const meetings = new Map(
    hydrated.meetings
      .filter((m) => m.user_id === callerUserId && m.access === 'owner')
      .map((m) => [m.assemblyai_id, m])
  );
  const regs = new Map(
    hydrated.registry.filter((r) => r.user_id === callerUserId).map((r) => [r.view.id, r.view])
  );
  const out: RecordingsPageItem[] = [];
  for (const k of keys) {
    if (k.kind === 'recording') {
      const recording = recs.get(k.id);
      if (!recording) continue;
      if (k.section === 'linked') {
        const meetings = hydrated.linkedMeetings?.get(k.id) ?? [];
        out.push({ kind: 'recording', section: 'linked', sort_us: k.sort_us, recording, meetings });
      } else {
        out.push({ kind: 'recording', section: k.section, sort_us: k.sort_us, recording });
      }
    } else if (k.kind === 'meeting') {
      const row = meetings.get(k.id);
      if (row) {
        const reg = row.recorder_recording_id ? regs.get(row.recorder_recording_id) ?? null : null;
        out.push({ kind: 'meeting', section: k.section, sort_us: k.sort_us, row, registry: reg });
      }
    } else {
      const registry = regs.get(k.id);
      if (registry && registry.status !== 'deleted') {
        out.push({ kind: 'registry', section: 'mac', sort_us: k.sort_us, registry });
      }
    }
  }
  return out;
}

export async function listOwnRecordingsSurface(
  user: { userId: string; email: string },
  q: RecordingsPageQuery
): Promise<OwnRecordingsResponse> {
  // In-flight legacy uploads of the caller's own keep advancing while
  // someone watches /recordings (the listing ran this fan-out before its
  // page). Only the caller's OWN pending rows are refreshed from here.
  if (q.limit > 0) {
    try {
      const pending = await listPendingVisibleToUser(user.userId, user.email);
      await refreshPendingAgainstAai(pending.filter((r) => r.user_id === user.userId));
    } catch (err) {
      console.warn('[GET /api/recordings] pending refresh failed:', err);
    }
  }

  const withStandalone = await standaloneColumnsExist().catch(() => false);
  const page = await listOwnRecordingsPage(user.userId, q, withStandalone);
  if (page.keys.length === 0) {
    return { items: [], next_cursor: null, counts: page.counts };
  }

  const recIds = page.keys.filter((k) => k.kind === 'recording').map((k) => k.id);
  const meetingIds = page.keys.filter((k) => k.kind === 'meeting').map((k) => k.id);
  const regIds = page.keys.filter((k) => k.kind === 'registry').map((k) => k.id);

  let recRows = withStandalone ? await getStandaloneViewsForOwner(user.userId, recIds) : [];
  // A recording still at AssemblyAI is asked about once (bounded), as the
  // meeting listing does for its pending rows.
  const processing = recRows.filter((r) => r.txn_status === 'processing').slice(0, 5);
  if (processing.length > 0) {
    await Promise.all(processing.map((r) => refreshBornBare(r.id).catch(() => false)));
    recRows = await getStandaloneViewsForOwner(user.userId, recIds);
  }
  const linkedIds = page.keys.filter((k) => k.kind === 'recording' && k.section === 'linked').map((k) => k.id);
  const linkedRefs = withStandalone && linkedIds.length > 0 ? await linkedMeetingsForOwnRecordings(user, linkedIds) : [];
  const linkedMeetings = groupLinkedMeetings(linkedRefs);
  const meetings = await hydrateOwnMeetingRows(user.userId, meetingIds);
  const linkedRegIds = meetings.map((m) => m.recorder_recording_id).filter((id): id is string => !!id);
  const regRows = await ownRegistryRowsByIds(user.userId, [...regIds, ...linkedRegIds]);

  const items = foldOwnPage(user.userId, page.keys, {
    recordings: recRows.map((r) =>
      recordingViewOf(
        r,
        (linkedMeetings.get(r.id) ?? []).map((m) => ({ assemblyai_id: m.assemblyai_id, title: m.title, trashed: false }))
      )
    ),
    recordingOwners: new Map(recRows.map((r) => [r.id, r.owner_user_id])),
    meetings,
    registry: regRows.map((r) => ({ user_id: r.user_id, view: ownView(r) })),
    linkedMeetings,
  });
  return {
    items,
    next_cursor: page.next
      ? encodeRecordingsCursor({ sortUs: page.next.sort_us, kind: page.next.kind, id: page.next.id })
      : null,
    counts: page.counts,
  };
}

/** The linked meetings by recording id, newest meeting first. */
export function groupLinkedMeetings(refs: LinkedMeetingRef[]): Map<string, LinkedMeeting[]> {
  const out = new Map<string, LinkedMeeting[]>();
  const iso = (v: string | Date | null) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  for (const r of refs) {
    const list = out.get(r.recording_id) ?? [];
    list.push({ assemblyai_id: r.assemblyai_id, title: r.title, recorded_at: iso(r.recorded_at as string | Date | null) });
    out.set(r.recording_id, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (b.recorded_at ?? '').localeCompare(a.recorded_at ?? ''));
  }
  return out;
}
