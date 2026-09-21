import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { clipsView } from '@/lib/server/clip-split';
import { addClip } from '@/lib/server/clip-combine';
import { combineRefusal, parseTimestampMs, type AddClipRequest } from '@/lib/clips';
import { isClipTextPolicy } from '@/lib/recording-clips';

/** A uuid — the only shape a recording id ever has. */
const RECORDING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ms field when it is a number, else the `mm:ss` one. */
function msOf(ms: number | null | undefined, clock: string | undefined): number | null {
  return typeof ms === 'number' ? parseTimestampMs(ms) : parseTimestampMs(clock);
}

export const runtime = 'nodejs';

/**
 * GET /api/transcripts/:id/clips
 *
 * Which windows of which recording this meeting uses, what the player must
 * clamp to, where the holes are, and — the part that matters — which OTHER
 * meetings sit on the same recording.
 *
 * PRIVACY: a recording has no ACL. The meeting is the gate (`resolveAccess`),
 * and every sibling is resolved through the CALLER's own owner-or-share
 * predicate in SQL (`listSiblingMeetingsForRecordings`). A person shared only
 * the split-off half never learns that the longer meeting exists: not its id,
 * not its title, not its window, not even that the list is non-empty
 * (feedback_privacy_caller_scoping_gate). `splitFrom` is served only when the
 * caller can open the meeting it names.
 *
 * `enabled: false` — `MW_CLIPS` off, 044–046 missing, or this meeting has no
 * clip — means the UI hides everything about clips and nothing else changes.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await clipsView(access, { userId: user.userId, email: user.email });
  return NextResponse.json(body);
});

/**
 * POST /api/transcripts/:id/clips — add a SECOND recording to this meeting
 * (Phase 3b, docs/recordings-phase3b-combine-spec.md; behind `MW_COMBINE`).
 *
 * Body (`AddClipRequest` in lib/clips.ts):
 *   { recordingId, fromMs?, toMs?, offsetMs, textPolicy? }
 * with `from` / `to` / `offset` accepted in `mm:ss` / `h:mm:ss` for darth-cli
 * and a typed field (the ms fields win). `offsetMs` is REQUIRED in spirit: the
 * server never guesses where a recording sits (spec §"The offset — never
 * guessed silently"); an absent one means 0, which is "they start together".
 *
 * PRIVACY (spec §Privacy): a recording's bytes belong to its owner, so the
 * caller may add ONLY recordings they own — adding someone else's is refused
 * `not-owned` even when the caller can edit the meeting that holds it, and
 * even when they can see it in the candidate list. The add itself is what
 * consents to this meeting's readers playing those bytes (`scopeMediaToRow`).
 *
 * Source (c) of the spec — a fresh upload made with `?attachTo=<meeting id>`
 * — is NOT wired up here: the upload routes are being changed in parallel.
 * `uploadSessionId` therefore answers `upload-deferred` rather than pretending.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const raw = (await request.json().catch(() => null)) as AddClipRequest | null;
  if (raw?.uploadSessionId && !raw.recordingId) {
    const refusal = combineRefusal('upload-deferred');
    return NextResponse.json({ error: refusal.message, code: refusal.code }, { status: 501 });
  }
  const recordingId = typeof raw?.recordingId === 'string' ? raw.recordingId.trim() : '';
  if (!RECORDING_ID_RE.test(recordingId)) {
    return NextResponse.json({ error: 'A recording is required.' }, { status: 400 });
  }

  const fromMs = msOf(raw?.fromMs, raw?.from) ?? 0;
  const toMs = raw?.toMs === null ? null : (msOf(raw?.toMs, raw?.to) ?? null);
  const offsetMs = msOf(raw?.offsetMs, raw?.offset) ?? 0;
  const textPolicy = isClipTextPolicy(raw?.textPolicy) ? raw.textPolicy : 'include';

  const out = await addClip({
    access,
    by: { userId: user.userId, email: user.email, name: user.name ?? null },
    recordingId,
    fromMs,
    toMs,
    offsetMs,
    textPolicy,
  });
  if (!out.ok) return NextResponse.json(out.body, { status: out.status });
  return NextResponse.json(out.body, { status: 201 });
});
