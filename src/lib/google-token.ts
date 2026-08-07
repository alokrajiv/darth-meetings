'use client';

/**
 * Browser-side Google OAuth via Google Identity Services (token model).
 *
 * We ask for a short-lived (~1h) access token with read-only Drive +
 * Calendar scopes. The token lives in module memory only — page reload
 * means a new popup (instant re-grant once the user has consented, since
 * the OAuth app is Internal to the Workspace).
 *
 * requestAccessToken() must be called from a user gesture (click) or the
 * popup gets blocked — callers should invoke getGoogleAccessToken() from a
 * button handler, not an effect.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  // Meet REST API: conferenceRecords lookup — finds recordings/transcripts
  // even when they aren't attached to the calendar event (e.g. tenants where
  // only "Notes by Gemini" shows up as an attachment).
  'https://www.googleapis.com/auth/meetings.space.readonly',
  // People API directory read: Meet participants come back as users/{id} +
  // display name only — this resolves them to org emails (feeds auto-share
  // for orphan imports that have no calendar invite list).
  'https://www.googleapis.com/auth/directory.readonly',
].join(' ');

const GSI_SRC = 'https://accounts.google.com/gsi/client';

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: '' | 'consent' | 'select_account' }) => void;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (resp: TokenResponse) => void;
            error_callback?: (err: { type?: string; message?: string }) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

let cached: { token: string; expiresAt: number } | null = null;
let scriptPromise: Promise<void> | null = null;

/**
 * The token also lives in sessionStorage so a page reload doesn't force a
 * fresh popup: it's origin-scoped, dies with the tab, and the token itself
 * expires in ~1h regardless — acceptable for an internal app with read-only
 * scopes. The scope list is stored alongside so adding a scope in a deploy
 * invalidates old cached tokens instead of silently 403ing.
 */
const STORAGE_KEY = 'mw_google_token';

function readStoredToken(): { token: string; expiresAt: number } | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      token?: string;
      expiresAt?: number;
      scopes?: string;
    };
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.scopes !== SCOPES
    ) {
      return null;
    }
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function writeStoredToken(value: { token: string; expiresAt: number } | null): void {
  try {
    if (value) {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...value, scopes: SCOPES })
      );
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // storage unavailable — memory cache still works
  }
}

function loadGsiScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GSI_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptPromise = null;
      reject(new Error('Failed to load Google sign-in script'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

/** True when a cached token has >2 min of life left (skip the connect step). */
export function hasValidGoogleToken(): boolean {
  if (!cached) cached = readStoredToken();
  return cached !== null && cached.expiresAt - Date.now() > 120_000;
}

/** Drop the cached token (e.g. after a Google API 401). */
export function invalidateGoogleToken(): void {
  cached = null;
  writeStoredToken(null);
}

/**
 * Users who connected their Google account in Settings (auth-code flow with
 * a server-held refresh token) get tokens minted server-side — no popup.
 * 404 = not connected; fall through to the GIS popup.
 */
async function tryServerMintedToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/google/token');
    if (!res.ok) return null;
    const json = (await res.json()) as { accessToken?: string; expiresAt?: number };
    if (typeof json.accessToken !== 'string') return null;
    cached = {
      token: json.accessToken,
      expiresAt: typeof json.expiresAt === 'number' ? json.expiresAt : Date.now() + 3300_000,
    };
    writeStoredToken(cached);
    return cached.token;
  } catch {
    return null;
  }
}

/**
 * One Internal OAuth client per Workspace org: trames-engineering.com users
 * must consent against THEIR org's client (Internal consent can't span
 * orgs — the sg client 403s them with org_internal). Resolved once per page
 * from the session's email.
 */
let popupClientIdPromise: Promise<string> | null = null;

function resolvePopupClientId(): Promise<string> {
  if (popupClientIdPromise) return popupClientIdPromise;
  popupClientIdPromise = (async () => {
    const sgId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
    const engId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID_ENG || '';
    if (!engId) return sgId;
    try {
      const res = await fetch('/api/whoami');
      if (res.ok) {
        const { email } = (await res.json()) as { email?: string };
        if (email?.toLowerCase().endsWith('@trames-engineering.com')) return engId;
      }
    } catch {
      // fall through to the sg client
    }
    return sgId;
  })();
  return popupClientIdPromise;
}

export async function getGoogleAccessToken(
  opts: { selectAccount?: boolean } = {}
): Promise<string> {
  if (!opts.selectAccount && hasValidGoogleToken()) return cached!.token;

  if (!opts.selectAccount) {
    const serverToken = await tryServerMintedToken();
    if (serverToken) return serverToken;
  }

  const clientId = await resolvePopupClientId();
  if (!clientId) {
    throw new Error('NEXT_PUBLIC_GOOGLE_CLIENT_ID is not configured');
  }

  await loadGsiScript();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error('Google sign-in script did not initialise');

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error_description || resp.error || 'Google auth failed'));
          return;
        }
        const expiresIn = Number(resp.expires_in) || 3600;
        cached = {
          token: resp.access_token,
          expiresAt: Date.now() + expiresIn * 1000,
        };
        writeStoredToken(cached);
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        reject(
          new Error(
            err?.type === 'popup_closed'
              ? 'Google sign-in was cancelled'
              : err?.message || 'Google sign-in popup failed'
          )
        );
      },
    });
    client.requestAccessToken(opts.selectAccount ? { prompt: 'select_account' } : undefined);
  });
}

/**
 * Force the Google account chooser and replace the cached token for the
 * whole app. Most flows never need this — the session-cached token wins —
 * but "wrong account" needs an exit.
 */
export async function switchGoogleAccount(): Promise<string> {
  invalidateGoogleToken();
  return getGoogleAccessToken({ selectAccount: true });
}
