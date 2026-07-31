/**
 * Next.js server-boot hook. Runs once per server process (node runtime only —
 * skipped for the edge/proxy bundle, which can't hold timers or DB handles).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startAutoNotesSweeper } = await import('@/lib/server/auto-notes-sweeper');
    startAutoNotesSweeper();
  }
}
