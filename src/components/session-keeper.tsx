'use client';

import { useEffect } from 'react';
import { installAuthFetchGuard } from '@/lib/auth-refresh';

// Install at module-eval time so the guard is in place before first-render
// fetches fire; the effect is a belt for any environment that skips module
// side effects. Idempotent either way.
installAuthFetchGuard();

/** Mounts the 401 → SSO-refresh → replay fetch guard. Renders nothing. */
export function SessionKeeper() {
  useEffect(() => {
    installAuthFetchGuard();
  }, []);
  return null;
}
