import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { findImportedByTeamsMeetings } from '@/db-ops/teams-import';
import { getAnyByAssemblyaiId } from '@/db-ops/transcripts';
import { addShare } from '@/db-ops/transcript-shares';
import { parseTeamsJoinLink } from '@/lib/teams-link';

export const runtime = 'nodejs';

/**
 * POST /api/teams/join
 * Body: { url, startTime? }
 *
 * Teams twin of /api/gmeet/join: join a colleague's existing import instead
 * of cloning it. Unlike Meet there is no per-user artifact access to prove
 * (the app fetched the content app-only) — the access test is the invite
 * list: the caller's email must be among the STORED event attendees of the
 * existing row (server-side truth captured at import, never client input).
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    url?: string;
    startTime?: string | null;
  } | null;
  const info = typeof body?.url === 'string' ? parseTeamsJoinLink(body.url) : null;
  if (!info) {
    return NextResponse.json({ error: 'url must be a Teams meeting link' }, { status: 400 });
  }
  const startTime = typeof body?.startTime === 'string' ? body.startTime : null;

  const [existing] = await findImportedByTeamsMeetings(
    [{ joinWebUrl: info.joinWebUrl, startTime }],
    { userId: user.userId, email: user.email }
  );
  if (!existing) {
    return NextResponse.json({ error: 'Nobody has imported this meeting yet.' }, { status: 404 });
  }
  if (existing.accessible) {
    return NextResponse.json({
      transcriptId: existing.assemblyai_id,
      title: existing.title,
      alreadyAccessible: true,
    });
  }

  const row = await getAnyByAssemblyaiId(existing.assemblyai_id);
  if (!row) {
    return NextResponse.json({ error: 'Existing import not found.' }, { status: 404 });
  }

  const email = user.email.trim().toLowerCase();
  const invited = (row.gmeet_context?.attendees ?? []).some(
    (a) => a.email?.trim().toLowerCase() === email
  );
  const organizer = row.gmeet_context?.organizerEmail?.trim().toLowerCase() === email;
  if (!invited && !organizer) {
    return NextResponse.json(
      {
        error:
          "You weren't on this meeting's invite — ask the importer to share it with you instead.",
      },
      { status: 403 }
    );
  }

  await addShare({
    transcriptId: row.id,
    ownerUserId: row.user_id,
    sharedByUserId: user.userId,
    sharedWithEmail: user.email,
    sharedWithName: null,
    sharedWithPplId: null,
    access: 'edit',
  });
  console.log(`[teams/join] ${user.email} joined ${row.assemblyai_id} (proof: invitee)`);

  return NextResponse.json({
    transcriptId: row.assemblyai_id,
    title: row.title,
    proof: 'invitee',
  });
});
