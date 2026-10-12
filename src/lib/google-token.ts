'use client';

import { connectionsHref } from '@/lib/darth-family';

/**
 * Google access tokens for the browser — server-served ONLY.
 *
 * The Google account link is held by darth-auth (since 2026-10-12): people
 * connect on auth's Connections page (`connectGoogle()` goes there with
 * `?return=` back here), and the server fetches short-lived access tokens
 * from auth. This module fetches them via /api/google/token. The old GIS
 * popup path is gone — no repeated popups, no user-gesture constraints;
 * token fetches can run in effects.
 */

/** Thrown when the user has no usable Google link — callers show a
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

// Landing back from auth's Connections page (`?connected=google`): the
// server may still remember "not linked" for this person for up to a minute
// (google-oauth's negative cache), so the first fetch asks it to forget.
// Read once at module load — pages strip the param in their own effects.
if (typeof window !== 'undefined') {
  try {
    if (new URLSearchParams(window.location.search).get('connected') === 'google') {
      forceNextMint = true;
    }
  } catch {
    // no location (tests) — nothing to do
  }
}

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
 * Navigate to auth's Connections page to link (or relink) Google.
 * `returnPath` (app-relative, e.g. '/?meet=1') is where auth sends the user
 * back afterwards (with `?connected=google` appended); default = here.
 */
export function connectGoogle(returnPath?: string): void {
  const ret = returnPath ?? window.location.pathname + window.location.search;
  window.location.href = connectionsHref(ret, window.location.origin);
}

/**
 * "Wrong calendar?" escape hatch: goes to auth's Connections page, where a
 * reconnect shows Google's account chooser. Full-page navigation — the
 * returned promise never resolves.
 */
export function switchGoogleAccount(returnPath?: string): Promise<never> {
  invalidateGoogleToken();
  connectGoogle(returnPath ?? window.location.pathname + window.location.search);
  return new Promise<never>(() => {});
}
