/**
 * Who may do what to a curated series — v2, "a series runs as its OWNER"
 * (docs/curated-series-spec.md §11.1). Replaces the v1 auditor-gated rules
 * (followed-series edit tier, auditor-only followers).
 *
 * | Who       | Sees | Edits definition | Editors + followers | Transfer | Delete |
 * |-----------|------|------------------|---------------------|----------|--------|
 * | owner     | yes  | yes              | yes                 | yes      | yes    |
 * | editor    | yes  | yes              | yes                 | no       | no     |
 * | follower  | yes  | no               | removes THEMSELVES  | no       | no     |
 * | auditor   | yes  | only as owner/editor                   | no       | no     |
 * | else      | NO — the series does not exist for them (404)                  |
 *
 * The safety is the REACH rule (engine): a series only matches meetings its
 * owner can open, and followers only get the members its owner may share.
 * Auditor-owned series reach EVERY meeting, so everyone who can change their
 * reach or audience must be an auditor too:
 *  - a non-auditor editor of an auditor-owned series is treated as having no
 *    edit rights (the routes also refuse to ADD one — 400);
 *  - only an auditor can make an auditor the owner (transfer-to).
 *
 * Pure + client-safe: the facts come from the server (who is an auditor is
 * a DB table the client never reads — it gets `isAuditor` and these
 * permissions from the API). Unit-tested in
 * src/lib/__tests__/series-permissions.test.ts.
 */

export interface SeriesRoleFacts {
  ownerEmail: string | null;
  ownerUserId?: string | null;
  ownerIsAuditor: boolean;
  /** Lower-cased. */
  editorEmails: readonly string[];
  /** Lower-cased. */
  followerEmails: readonly string[];
}

export interface SeriesCallerFacts {
  callerEmail: string;
  callerUserId?: string | null;
  callerIsAuditor: boolean;
}

export type SeriesRole = 'owner' | 'editor' | 'follower' | 'auditor';

export interface SeriesPermissions {
  /** The caller's strongest role; null = cannot see the series. */
  role: SeriesRole | null;
  see: boolean;
  /** Name, description, patterns, labels, priority, auto-import. */
  edit: boolean;
  manageEditors: boolean;
  /** Add anyone / remove anyone as a follower. */
  manageFollowers: boolean;
  transfer: boolean;
  delete: boolean;
  isOwner: boolean;
  isEditor: boolean;
  isFollower: boolean;
  isAuditor: boolean;
  /** Auditor-owned: the series reaches every meeting (policy). */
  ownerIsAuditor: boolean;
}

export const SERIES_EDIT_DENIED = 'Only the owner or an editor of this series can change it';
export const SERIES_MANAGE_DENIED =
  'Only the owner or an editor of this series can add or remove its editors and followers';
export const SERIES_TRANSFER_DENIED = 'Only the owner of this series can hand it to someone else';
export const SERIES_DELETE_DENIED = 'Only the owner of this series can delete it';
export const SERIES_AUDITOR_EDITOR_ONLY =
  'This series is owned by an auditor and reaches every meeting — its editors must be auditors too';
export const SERIES_AUDITOR_OWNER_ONLY =
  'Only an auditor can make an auditor the owner of a series (an auditor-owned series reaches every meeting)';

const norm = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();

export function seriesPermissions(facts: SeriesRoleFacts, caller: SeriesCallerFacts): SeriesPermissions {
  const me = norm(caller.callerEmail);
  const isOwner =
    (!!me && norm(facts.ownerEmail) === me) ||
    (!!caller.callerUserId && !!facts.ownerUserId && caller.callerUserId === facts.ownerUserId);
  const isEditor = !!me && facts.editorEmails.some((e) => norm(e) === me);
  const isFollower = !!me && facts.followerEmails.some((e) => norm(e) === me);
  const isAuditor = caller.callerIsAuditor;
  const role: SeriesRole | null = isOwner
    ? 'owner'
    : isEditor
      ? 'editor'
      : isFollower
        ? 'follower'
        : isAuditor
          ? 'auditor'
          : null;
  // An auditor-owned series reaches every meeting: an editor who is not an
  // auditor (possible only if the auditors table changed under it) loses
  // the editing rights rather than steering an org-wide reach.
  const editorCounts = isEditor && (!facts.ownerIsAuditor || isAuditor);
  const edit = isOwner || editorCounts;
  return {
    role,
    see: role !== null,
    edit,
    manageEditors: edit,
    manageFollowers: edit,
    transfer: isOwner,
    delete: isOwner,
    isOwner,
    isEditor,
    isFollower,
    isAuditor,
    ownerIsAuditor: facts.ownerIsAuditor,
  };
}

/** canSeeSeries (§11.6) = owner | editor | follower | auditor. */
export function canSeeSeries(facts: SeriesRoleFacts, caller: SeriesCallerFacts): boolean {
  return seriesPermissions(facts, caller).see;
}

/** May the caller remove `followerEmail`? Owner/editors anyone; a follower
 * only themselves. */
export function canRemoveFollower(
  facts: SeriesRoleFacts,
  caller: SeriesCallerFacts,
  followerEmail: string
): boolean {
  const p = seriesPermissions(facts, caller);
  if (p.manageFollowers) return true;
  const me = norm(caller.callerEmail);
  return p.see && !!me && me === norm(followerEmail);
}

export type Verdict = { ok: true } | { ok: false; status: 403 | 400; error: string };

/** May the caller make someone (auditor or not) an editor? */
export function canAddEditor(
  facts: SeriesRoleFacts,
  caller: SeriesCallerFacts,
  editorIsAuditor: boolean
): Verdict {
  if (!seriesPermissions(facts, caller).manageEditors) {
    return { ok: false, status: 403, error: SERIES_MANAGE_DENIED };
  }
  if (facts.ownerIsAuditor && !editorIsAuditor) {
    return { ok: false, status: 400, error: SERIES_AUDITOR_EDITOR_ONLY };
  }
  return { ok: true };
}

/**
 * May the caller hand the series to a target? Owner only; an auditor target
 * only by an auditor, and only when every editor afterwards (the old owner
 * becomes one) is an auditor too — otherwise a non-auditor would keep
 * editing a series that now reaches every meeting.
 */
export function canTransferTo(
  facts: SeriesRoleFacts,
  caller: SeriesCallerFacts,
  target: { isAuditor: boolean; nonAuditorEditorsAfter: number }
): Verdict {
  if (!seriesPermissions(facts, caller).transfer) {
    return { ok: false, status: 403, error: SERIES_TRANSFER_DENIED };
  }
  if (target.isAuditor && !caller.callerIsAuditor) {
    return { ok: false, status: 403, error: SERIES_AUDITOR_OWNER_ONLY };
  }
  if (target.isAuditor && target.nonAuditorEditorsAfter > 0) {
    return { ok: false, status: 400, error: SERIES_AUDITOR_EDITOR_ONLY };
  }
  return { ok: true };
}
