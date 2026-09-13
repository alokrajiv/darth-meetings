'use client';

import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clearAllOffline } from '@/lib/offline/offline-pins';

/** Logout = darth-auth's `/logout` (SPEC §3.7). `/logout` here is a server
 * route that 302s to `${DARTH_AUTH_URL}/logout?returnTo=<app root>`, so the
 * auth base URL never has to be baked into the client bundle. */
export function LogoutButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-8 p-0"
      onClick={async () => {
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
      title="Logout"
    >
      <LogOut className="h-4 w-4" />
      <span className="sr-only">Logout</span>
    </Button>
  );
}
