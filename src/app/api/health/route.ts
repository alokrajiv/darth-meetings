import { NextResponse } from 'next/server';

/**
 * Reachability probe — the cheapest possible answer from THIS process: no
 * auth, no DB, no darth-auth round-trip. Kept for native clients (the Mac
 * tray, the Darth desktop shell) that race it against a short cap: a miss
 * means "the app is unreachable", which on a laptop whose VPN tunnel stays
 * up with Wi-Fi off is the only signal there is (the OS keeps saying online,
 * requests just hang). Listed as public in src/proxy.ts. (Its first caller,
 * the web app's own offline mode, was removed 2026-10-02.)
 *
 * 204 so the body can never be mistaken for data; no-store so no cache
 * layer (browser, nginx) can answer for the server.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return new NextResponse(null, {
    status: 204,
    headers: { 'cache-control': 'no-store, max-age=0', 'x-darth-health': 'ok' },
  });
}

export function HEAD() {
  return GET();
}
