/**
 * Who may do what to a curated series (docs/curated-series-spec.md §6, owner
 * 2026-10-06). Replaces lib/series-owner (D4's organiser-or-creator rule for
 * delete/merge of the key-based series — merge no longer exists).
 *
 * Following a series grants READ ACCESS to other people's meetings, so
 * everything that decides who receives that access is an auditor's act:
 *
 *  - add / remove followers: auditors only (lib/auditor-policy AUDITORS);
 *    any follower may remove THEMSELVES;
 *  - edit the patterns or priority of a series that HAS followers: auditors
 *    only — otherwise anyone could widen a followed series to `.*` (or win a
 *    priority fight) and pull every meeting to its followers;
 *  - a series without followers: anyone may edit name, description,
 *    patterns, priority and labels (labels grant nothing);
 *  - delete a series: an auditor, or its creator while it has no followers;
 *  - everyone SEES every series.
 *
 * Pure + client-safe: the routes enforce it, the dialog greys out what the
 * caller cannot do. Unit-tested in src/lib/__tests__/series-permissions.test.ts.
 */

import { isAuditorEmail } from '@/lib/auditor-policy';

export interface SeriesCaller {
  userId: string;
  email: string;
}

export interface SeriesPermissionFacts {
  /** series.created_by. */
  createdBy: string | null;
  /** Lower-cased follower emails. */
  followerEmails: readonly string[];
}

export interface SeriesPermissions {
  isAuditor: boolean;
  /** Patterns + priority. */
  editMatching: boolean;
  /** Add/remove anyone as a follower. */
  manageFollowers: boolean;
  /** The caller follows the series (and so may unfollow). */
  isFollower: boolean;
  delete: boolean;
}

export const SERIES_FOLLOWERS_AUDITOR_ONLY =
  'Only an auditor can add or remove followers — following gives read access to every meeting in the series';
export const SERIES_MATCHING_AUDITOR_ONLY =
  'This series has followers, so only an auditor can change its patterns or priority (the followers get every meeting it matches)';
export const SERIES_DELETE_DENIED =
  'Only an auditor, or the person who created this series while nobody follows it, can delete it';

const norm = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();

export function seriesPermissions(facts: SeriesPermissionFacts, caller: SeriesCaller): SeriesPermissions {
  const isAuditor = isAuditorEmail(caller.email);
  const me = norm(caller.email);
  const isFollower = !!me && facts.followerEmails.some((f) => norm(f) === me);
  return {
    isAuditor,
    editMatching: facts.followerEmails.length === 0 || isAuditor,
    manageFollowers: isAuditor,
    isFollower,
    // A followed series is an auditor's: deleting it would drop every
    // follower's access as surely as unfollowing them.
    delete: isAuditor || (facts.followerEmails.length === 0 && !!facts.createdBy && facts.createdBy === caller.userId),
  };
}

/** May the caller remove `followerEmail` from the series? Auditors anyone,
 * everybody else only themselves. */
export function canRemoveFollower(caller: SeriesCaller, followerEmail: string): boolean {
  if (isAuditorEmail(caller.email)) return true;
  const me = norm(caller.email);
  return !!me && me === norm(followerEmail);
}
