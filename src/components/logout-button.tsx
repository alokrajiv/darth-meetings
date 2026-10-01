import { clearAllOffline } from '@/lib/offline/offline-pins';

/** Logout = darth-auth's `/logout` (SPEC §3.7). `/logout` here is a server
 * route that 302s to `${DARTH_AUTH_URL}/logout?returnTo=<app root>`, so the
 * auth base URL never has to be baked into the client bundle.
 *
 * Callers keep the control disabled while offline / the network is down
 * (useOfflineGate().blocked): the /logout navigation cannot succeed, and the
 * wipe below must never run without it (it would destroy the pinned archive
 * the user is reading). Used by the header's account menu. */
export async function signOut(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  // Offline copies are per-session data: wipe them before the session goes
  // so the next person on this browser cannot open them. Best effort with a
  // 3 s cap — a stuck cache API must not block logout.
  try {
    await Promise.race([
      clearAllOffline(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    // ignore — logout proceeds regardless
  }
  window.location.href = '/logout';
}
