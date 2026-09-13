'use client';

import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clearAllOffline } from '@/lib/offline/offline-pins';
import { OFFLINE_TITLE, useOfflineGate } from '@/lib/offline/offline-context';

/** Logout = darth-auth's `/logout` (SPEC §3.7). `/logout` here is a server
 * route that 302s to `${DARTH_AUTH_URL}/logout?returnTo=<app root>`, so the
 * auth base URL never has to be baked into the client bundle. */
export function LogoutButton() {
  // Offline / network down: the /logout navigation cannot succeed, and the
  // wipe below must never run without it (it would destroy the pinned
  // archive the user is reading). Disabled, still visible.
  const { blocked } = useOfflineGate();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-8 p-0"
      disabled={blocked}
      onClick={async () => {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        // Offline copies are per-session data: wipe them before the session
        // goes so the next person on this browser cannot open them. Best
        // effort with a 3 s cap — a stuck cache API must not block logout.
        try {
          await Promise.race([
            clearAllOffline(),
            new Promise<void>((resolve) => setTimeout(resolve, 3000)),
          ]);
        } catch {
          // ignore — logout proceeds regardless
        }
        window.location.href = '/logout';
      }}
      title={blocked ? OFFLINE_TITLE : 'Logout'}
    >
      <LogOut className="h-4 w-4" />
      <span className="sr-only">Logout</span>
    </Button>
  );
}
