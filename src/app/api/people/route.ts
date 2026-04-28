import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { createCustomPerson, findPersonByEmail } from '@/db-ops/people';

export const runtime = 'nodejs';

/**
 * POST /api/people
 *
 * Body: { name: string, email: string }
 *
 * Looks the email up in both the Trames directory (darth_plagueis.ppl) and
 * our own custom people table. If found, responds 409 with the existing
 * record so the client can offer "use existing person" instead of creating
 * a duplicate. If not found, creates a new row in
 * meeting_whisperer_prod.people and responds 201 with the new record.
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name, email } = (body ?? {}) as { name?: unknown; email?: unknown };
  if (typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (typeof email !== 'string' || !email.includes('@') || email.trim().length < 3) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }

  const existing = await findPersonByEmail(email);
  if (existing) {
    return NextResponse.json(
      { error: 'exists', person: existing },
      { status: 409 }
    );
  }

  try {
    const person = await createCustomPerson({
      name: name.trim(),
      email: email.trim(),
      createdBy: user.userId,
    });
    return NextResponse.json({ person }, { status: 201 });
  } catch (err) {
    // Could be a race — the email became taken between findPersonByEmail
    // and INSERT. Surface as 409 with whatever's in the DB now.
    const nowExisting = await findPersonByEmail(email);
    if (nowExisting) {
      return NextResponse.json(
        { error: 'exists', person: nowExisting },
        { status: 409 }
      );
    }
    console.error('[POST /api/people] insert failed:', err);
    return NextResponse.json({ error: 'Failed to create person' }, { status: 500 });
  }
});
