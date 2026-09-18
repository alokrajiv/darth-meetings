import { withAuth } from '@/lib/auth/with-auth';
import { subscribeEvents } from '@/lib/server/event-bus';
import { canAccessTranscript } from '@/db-ops/transcript-access';

export const runtime = 'nodejs';
// SSE connections are long-lived; match the upload route's ceiling.
export const maxDuration = 900;

/**
 * GET /api/events — Server-Sent Events stream of transcript changes.
 * Every mutation path publishes onto the in-process bus; connected browsers
 * use this to silently refresh the archive list and open detail pages.
 * `X-Accel-Buffering: no` stops nginx from buffering the stream.
 *
 * PRIVACY GATE (tech-debt D4, 2026-09-18): the subscription is scoped to
 * the caller — an event naming a transcript reaches this stream only when
 * `canAccessTranscript` (owner or share) holds for them; the bus caches the
 * verdict per (user, id), so a reconnect (the client retries every 5 s on a
 * drop) re-uses warm verdicts instead of re-querying.
 */
export const GET = withAuth(async ({ user, request }) => {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const scopeUser = { userId: user.userId, email: user.email };

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      write(`data: {"kind":"hello"}\n\n`);
      const unsub = subscribeEvents((e) => write(`data: ${JSON.stringify(e)}\n\n`), {
        user: scopeUser,
        canSee: (id) => canAccessTranscript(scopeUser.userId, scopeUser.email, id),
      });
      const heartbeat = setInterval(() => write(': hb\n\n'), 25_000);
      const teardown = () => {
        closed = true;
        clearInterval(heartbeat);
        unsub();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener('abort', teardown);
      cleanup = teardown;
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
