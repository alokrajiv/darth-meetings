import 'server-only';
import type { RecorderRecordingRow } from '@/db-ops/recorder';
import { listOwnRecordings } from '@/db-ops/recorder';
import { listPagedForUser, listPendingVisibleToUser } from '@/db-ops/transcripts';
import type { TranscriptListRow } from '@/lib/format';
import { isBareRecording } from '@/lib/meeting-title';
import { refreshPendingAgainstAai } from '@/lib/server/aai-pending-refresh';
import { ownView, type OwnRecordingView } from '@/lib/server/recorder-view';

/**
 * The Recordings surface's own endpoint — `GET /api/recordings?mine=1`
 * (docs/recordings-meetings-series-design.md §4.1, step P6).
 *
 * A PURE RE-ROUTING: it is fed by exactly the two halves the old Recordings
 * tab fetched for itself (the Darth Recorder registry, and the caller's
 * `transcripts` rows that are bare recordings), plus the caller's temporary
 * (scratch) rows that the old Temporary tab listed. Nothing is re-modelled
 * here — under P7 the second and third halves become `recordings` rows and
 * this is the one place that changes.
 *
 * STRICTLY THE CALLER'S OWN (invariant I2). A recording is its owner's and
 * nobody else's; not even its existence reaches anyone else. Every half is
 * asked with an owner predicate in SQL (`listOwnRecordings`: `user_id = $1`;
 * the listing's `mine` tab: `AND t.user_id = $1`), and `foldOwnRecordings`
 * filters again on the row's own `user_id` — the belt on the braces, and
 * the thing that keeps a SHARED temporary row (the listing's `scratch` tab
 * is owned + shared) off this surface: a temporary upload someone shared
 * with you is their recording, not yours (Q7 grandfathers the share; it
 * does not make it yours).
 */

export interface OwnRecordingsQuery {
  /** Section 1 + 2: registry rows and bare uploads. */
  unlinked: boolean;
  /** Section 3: the caller's own temporary rows. */
  temporary: boolean;
  tz: string;
}

export interface OwnRecordingsResponse {
  /** Own Darth Recorder registry rows, every status except deleted. The
   * client folds the ones still on a Mac (not represented by an uploaded
   * row) into "On your Macs". Present when `unlinked`. */
  registry?: OwnRecordingView[];
  /** Own uploads that belong to no meeting yet (no calendar event, no human
   * title — lib/meeting-title `isBareRecording`), newest first. Present when
   * `unlinked`. Listing-v2 row shape. */
  unlinked?: TranscriptListRow[];
  /** Own temporary uploads (migration 042), newest first. Present when
   * `temporary`. Listing-v2 row shape. */
  temporary?: TranscriptListRow[];
}

const TZ_RE = /^[A-Za-z0-9_/+-]{1,64}$/;

/** `?mine=1[&unlinked=1][&temporary=1][&tz=]` → the query, or an error.
 * Neither section flag = both sections. */
export function parseOwnRecordingsQuery(
  params: URLSearchParams
): { ok: true; query: OwnRecordingsQuery } | { ok: false; error: string } {
  if (params.get('mine') !== '1') {
    return {
      ok: false,
      error: 'Expected ?mine=1 — recordings are listed for their owner only',
    };
  }
  const u = params.get('unlinked') === '1';
  const t = params.get('temporary') === '1';
  let tz = params.get('tz') ?? 'UTC';
  if (!TZ_RE.test(tz)) tz = 'UTC';
  else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      tz = 'UTC';
    }
  }
  return { ok: true, query: { unlinked: u || !t, temporary: t || !u, tz } };
}

/**
 * The fold, pure: keeps only what the caller OWNS. `registry` rows by their
 * `user_id`; archive rows by `user_id` AND `access === 'owner'` (a row the
 * caller merely has a share on is never theirs to list here).
 */
export function foldOwnRecordings(
  callerUserId: string,
  halves: {
    registry?: RecorderRecordingRow[];
    mineRows?: TranscriptListRow[];
    scratchRows?: TranscriptListRow[];
  }
): OwnRecordingsResponse {
  const own = (r: TranscriptListRow) => r.user_id === callerUserId && r.access === 'owner';
  const out: OwnRecordingsResponse = {};
  if (halves.registry) {
    out.registry = halves.registry
      .filter((r) => r.user_id === callerUserId && r.status !== 'deleted')
      .map(ownView);
  }
  if (halves.mineRows) {
    out.unlinked = halves.mineRows.filter((r) => own(r) && isBareRecording(r));
  }
  if (halves.scratchRows) {
    out.temporary = halves.scratchRows.filter((r) => own(r) && !!r.scratch && !r.deleted_at);
  }
  return out;
}

/** Same window the old tab fetched: the newest 60 day-buckets / ~200 rows. */
const WINDOW = { days: 60, minRows: 200 } as const;

export async function listOwnRecordingsSurface(
  user: { userId: string; email: string },
  q: OwnRecordingsQuery
): Promise<OwnRecordingsResponse> {
  // In-flight uploads of the caller's own progress on this surface exactly
  // as they did on the listing (which ran this fan-out before its page).
  // Only the caller's OWN pending rows are refreshed from here.
  try {
    const pending = await listPendingVisibleToUser(user.userId, user.email);
    await refreshPendingAgainstAai(pending.filter((r) => r.user_id === user.userId));
  } catch (err) {
    console.warn('[GET /api/recordings] pending refresh failed:', err);
  }

  const page = (tab: 'mine' | 'scratch') =>
    listPagedForUser(user.userId, user.email, {
      tab,
      from: null,
      to: null,
      tz: q.tz,
      q: null,
      days: WINDOW.days,
      minRows: WINDOW.minRows,
      cursor: null,
    }).then((r) => r.days.flatMap((d) => d.rows));

  const [registry, mineRows, scratchRows] = await Promise.all([
    q.unlinked ? listOwnRecordings(user.userId) : Promise.resolve(undefined),
    q.unlinked ? page('mine') : Promise.resolve(undefined),
    q.temporary ? page('scratch') : Promise.resolve(undefined),
  ]);
  return foldOwnRecordings(user.userId, { registry, mineRows, scratchRows });
}
