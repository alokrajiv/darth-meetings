'use client';

/**
 * Google access tokens for the browser — server-minted ONLY.
 *
 * There is exactly one "Connect Google" in the app: the auth-code flow at
 * /api/google/connect, which stores a per-user encrypted refresh token
 * server-side (and powers the background sync-and-remind poller). This
 * module fetches short-lived access tokens minted from that refresh token
 * via /api/google/token. The old GIS popup path is gone — no more repeated
 * popups, no user-gesture constraints; token fetches can run in effects.
 */

/** Thrown when the user hasn't connected Google yet — callers show a
 * Connect button that calls connectGoogle(). */
export class GoogleNotConnectedError extends Error {
  constructor() {
    super('Google account not connected yet — hit Connect Google (one time).');
    this.name = 'GoogleNotConnectedError';
  }
}

let cached: { token: string; expiresAt: number } | null = null;
/** Set by invalidateGoogleToken(): the next fetch asks the server to re-mint
 * instead of serving its own cache (which may hold the token that just 401d). */
let forceNextMint = false;

const STORAGE_KEY = 'mw_google_token_v2';

function readStoredToken(): { token: string; expiresAt: number } | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string; expiresAt?: number };
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function writeStoredToken(value: { token: string; expiresAt: number } | null): void {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable — memory cache still works
  }
}

/** True when a cached token has >2 min of life left. */
export function hasValidGoogleToken(): boolean {
  if (!cached) cached = readStoredToken();
  return cached !== null && cached.expiresAt - Date.now() > 120_000;
}

/** Drop the cached token (e.g. after a Google API 401). */
export function invalidateGoogleToken(): void {
  cached = null;
  forceNextMint = true;
  writeStoredToken(null);
}

export async function getGoogleAccessToken(): Promise<string> {
  if (hasValidGoogleToken()) return cached!.token;

  const url = forceNextMint ? '/api/google/token?force=1' : '/api/google/token';
  const res = await fetch(url);
  if (res.status === 404) throw new GoogleNotConnectedError();
  if (!res.ok) throw new Error(`Google token fetch failed (${res.status})`);
  forceNextMint = false;
  const json = (await res.json()) as { accessToken?: string; expiresAt?: number };
  if (typeof json.accessToken !== 'string') throw new Error('Malformed token response');
  cached = {
    token: json.accessToken,
    expiresAt: typeof json.expiresAt === 'number' ? json.expiresAt : Date.now() + 3300_000,
  };
  writeStoredToken(cached);
  return cached.token;
}

/**
 * Navigate to the one-time connect flow. `returnPath` (must be app-relative,
 * e.g. '/?meet=1') is where the callback drops the user afterwards.
 */
export function connectGoogle(returnPath?: string): void {
  const url = new URL('/api/google/connect', window.location.origin);
  if (returnPath) url.searchParams.set('return', returnPath);
  window.location.href = url.toString();
}

/**
 * "Wrong calendar?" escape hatch: re-runs the connect flow, which forces
 * Google's account chooser. Full-page navigation — the returned promise
 * never resolves, the callback redirect takes over.
 */
export function switchGoogleAccount(returnPath?: string): Promise<never> {
  invalidateGoogleToken();
  connectGoogle(returnPath ?? window.location.pathname + window.location.search);
  return new Promise<never>(() => {});
}
