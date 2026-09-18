/**
 * Installed-app (PWA) helpers — tech-debt C2. Dep-free, safe to call
 * during SSR (every function answers "no" without a window).
 */

/** Launched from the Dock / Home Screen (manifest display: standalone, or Safari's flag). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch {
    /* no matchMedia */
  }
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

/** Badging API present (Chrome/Edge desktop + Android, Safari macOS 17+ for installed apps). */
export function badgingSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { setAppBadge?: unknown; clearAppBadge?: unknown };
  return typeof nav.setAppBadge === 'function' && typeof nav.clearAppBadge === 'function';
}

/** Set (n > 0) or clear (n <= 0) the app icon badge. Never throws. */
export async function setAppBadge(n: number): Promise<void> {
  if (!badgingSupported()) return;
  const nav = navigator as Navigator & {
    setAppBadge: (n?: number) => Promise<void>;
    clearAppBadge: () => Promise<void>;
  };
  try {
    if (n > 0) await nav.setAppBadge(Math.min(Math.floor(n), 999));
    else await nav.clearAppBadge();
  } catch {
    /* denied / unsupported at runtime */
  }
}

export function clearAppBadge(): Promise<void> {
  return setAppBadge(0);
}

/** Whether the browser has granted persistent storage (no eviction without the user). null = unknown. */
export async function storagePersisted(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return null;
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}
