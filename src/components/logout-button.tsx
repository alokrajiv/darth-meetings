'use client';

import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Logout = darth-auth's `/logout` (SPEC §3.7). `/logout` here is a server
 * route that 302s to `${DARTH_AUTH_URL}/logout?returnTo=<app root>`, so the
 * auth base URL never has to be baked into the client bundle. */
export function LogoutButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-8 p-0"
      onClick={() => {
        window.location.href = '/logout';
      }}
      title="Logout"
    >
      <LogOut className="h-4 w-4" />
      <span className="sr-only">Logout</span>
    </Button>
  );
}
