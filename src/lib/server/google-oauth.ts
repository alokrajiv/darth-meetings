import 'server-only';
import crypto from 'crypto';
import { config } from '@/config';
import {
  getGoogleAccount,
  markGoogleAccountStatus,
} from '@/db-ops/google-accounts';

/**
 * Server-side Google OAuth (auth-code flow with offline access).
 *
 * The browser GIS popup mints ~1h tokens with no server involvement; this
 * module is the durable counterpart: per-user refresh tokens, encrypted at
 * rest (AES-256-GCM, key = GOOGLE_TOKEN_ENC_KEY), from which the server
 * mints short-lived access tokens for the background poller and for the
 * frontend (so connected users never see the popup again).
 *
 * Scopes are strictly read-only + `openid email` for identifying which
 * Google account got connected.
 */

export const OFFLINE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
].join(' ');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * One Internal OAuth client per Workspace org (Internal consent can't span
 * orgs): 'sg' = trames.sg, 'eng' = trames-engineering.com. Refresh tokens
 * are client-bound at Google, so the issuing client is persisted on the
 * account row and reused for every refresh.
 */
export type GoogleClientKey = 'sg' | 'eng';

export function clientKeyForEmail(email: string): GoogleClientKey {
  return email.toLowerCase().endsWith('@trames-engineering.com') ? 'eng' : 'sg';
}

function clientCreds(key: GoogleClientKey): { id: string; secret: string } {
  const id = key === 'eng' ? config.google.clientIdEng : config.google.clientId;
  const secret = key === 'eng' ? config.google.clientSecretEng : config.google.clientSecret;
  if (!id || !secret) {
    throw new Error(`Google OAuth client '${key}' is not configured on the server`);
  }
  return { id, secret };
}

export function isClientConfigured(key: GoogleClientKey): boolean {
  try {
    clientCreds(key);
    return true;
  } catch {
    return false;
  }
}

/** Thrown when Google says the refresh token is dead (user revoked it). */
export class GoogleGrantRevokedError extends Error {
  constructor(detail: string) {
    super(`Google grant revoked: ${detail}`);
    this.name = 'GoogleGrantRevokedError';
  }
}

// ---------------------------------------------------------------------------
// Encryption: AES-256-GCM, blob format "iv.ciphertext.tag" (base64url).

function encKey(): Buffer {
  const hex = config.google.tokenEncKey;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('GOOGLE_TOKEN_ENC_KEY must be 64 hex chars (openssl rand -hex 32)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, ct, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}

export function decryptToken(blob: string): string {
  const [iv, ct, tag] = blob.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !ct || !tag) throw new Error('Malformed encrypted token blob');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Signed state for the connect round-trip. HMAC key derived from the enc key
// so no extra secret to manage; callback checks signature, age, and that the
// state was minted for the SAME SSO user now completing it.

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function stateSig(payload: string): string {
  return crypto.createHmac('sha256', encKey()).update(payload).digest('base64url');
}

export function mintState(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, t: Date.now(), n: crypto.randomBytes(8).toString('hex') })
  ).toString('base64url');
  return `${payload}.${stateSig(payload)}`;
}

export function verifyState(state: string, expectedUserId: string): boolean {
  const dot = state.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = stateSig(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u?: string;
      t?: number;
    };
    return parsed.u === expectedUserId && Date.now() - (parsed.t ?? 0) <= STATE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OAuth endpoints.

export function redirectUri(): string {
  return `${config.google.appBaseUrl.replace(/\/$/, '')}/api/google/callback`;
}

export function buildAuthUrl(state: string, clientKey: GoogleClientKey): string {
  const params = new URLSearchParams({
    client_id: clientCreds(clientKey).id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: OFFLINE_SCOPES,
    access_type: 'offline',
    // Force the consent screen so Google re-issues a refresh token even for
    // users who already granted these scopes to the popup client.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

export interface CodeExchangeResult {
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
  scope: string;
  /** Email from the id_token payload (unverified decode — it came straight
   * from Google's token endpoint over TLS, so no signature check needed). */
  email: string | null;
}

export async function exchangeCode(
  code: string,
  clientKey: GoogleClientKey
): Promise<CodeExchangeResult> {
  const creds = clientCreds(clientKey);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: creds.id,
      client_secret: creds.secret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`Code exchange failed: ${json.error ?? res.status} ${json.error_description ?? ''}`);
  }
  if (!json.refresh_token) {
    // access_type=offline + prompt=consent should always yield one.
    throw new Error('Google did not return a refresh token');
  }
  let email: string | null = null;
  if (json.id_token) {
    try {
      const payload = json.id_token.split('.')[1];
      email = (JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { email?: string }).email ?? null;
    } catch {
      // cosmetic only
    }
  }
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresIn: json.expires_in ?? 3600,
    scope: json.scope ?? OFFLINE_SCOPES,
    email,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  clientKey: GoogleClientKey
): Promise<{ accessToken: string; expiresIn: number }> {
  const creds = clientCreds(clientKey);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: creds.id,
      client_secret: creds.secret,
      grant_type: 'refresh_token',
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    const detail = `${json.error ?? res.status} ${json.error_description ?? ''}`.trim();
    if (json.error === 'invalid_grant') throw new GoogleGrantRevokedError(detail);
    throw new Error(`Token refresh failed: ${detail}`);
  }
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

/** Best-effort revocation at Google when the user disconnects. */
export async function revokeToken(refreshToken: string): Promise<void> {
  try {
    await fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch {
    // deleting our row is the part that matters
  }
}

// ---------------------------------------------------------------------------
// Access-token cache: minted tokens live in process memory only (single pm2
// process), keyed by user, dropped 2 min before expiry.

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function invalidateServerToken(userId: string): void {
  tokenCache.delete(userId);
}

/**
 * Mint (or reuse) an access token for a connected user. Returns null when the
 * user has no usable connection. On invalid_grant the account row is marked
 * revoked so the poller stops visiting and the UI can prompt a reconnect.
 */
export async function getServerAccessToken(
  userId: string
): Promise<{ token: string; expiresAt: number } | null> {
  const hit = tokenCache.get(userId);
  if (hit && hit.expiresAt - Date.now() > 120_000) return hit;

  const account = await getGoogleAccount(userId);
  if (!account || account.status === 'revoked') return null;

  let refreshToken: string;
  try {
    refreshToken = decryptToken(account.refresh_token_enc);
  } catch (err) {
    await markGoogleAccountStatus(userId, 'error', `decrypt failed: ${String(err)}`);
    return null;
  }

  try {
    const minted = await refreshAccessToken(refreshToken, account.client_key);
    const entry = { token: minted.accessToken, expiresAt: Date.now() + minted.expiresIn * 1000 };
    tokenCache.set(userId, entry);
    await markGoogleAccountStatus(userId, 'ok', null);
    return entry;
  } catch (err) {
    if (err instanceof GoogleGrantRevokedError) {
      await markGoogleAccountStatus(userId, 'revoked', err.message);
      return null;
    }
    // transient (network, 5xx) — keep status, let the caller retry later
    await markGoogleAccountStatus(userId, 'error', String(err));
    return null;
  }
}
