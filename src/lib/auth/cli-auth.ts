/**
 * darth-auth introspection helper — the ONE place this app verifies a caller.
 *
 * Accepts every darth-auth credential kind (SPEC §3.1):
 *   - `dss_…`  the `darth_session` browser cookie (opaque, issued by darth-auth)
 *   - `dth_…`  a darth-cli user token (`Authorization: Bearer dth_…`)
 *   - `dapp_…` a delegated-app token (resolved for completeness; meetings has
 *              no inbound app-token routes, so withAuth rejects it)
 *
 * Every value is POSTed to `DARTH_AUTH_INTERNAL_URL/api/introspect` (loopback on
 * the VM) with `service:'meetings'` and cached 60 s in-process keyed by the raw
 * value, so bursts of requests cost one HTTP hop per minute per credential.
 * Transient introspection failures are NOT cached.
 *
 * The userId darth-auth returns for `trames-sso` users is the kenoby userId
 * verbatim (SPEC §2.1), so it drops straight into the row-level ACLs keyed on
 * `user.userId`.
 */

const INTROSPECT_URL =
  process.env.DARTH_AUTH_INTROSPECT_URL ||
  process.env.AUTH_INTROSPECT_URL ||
  `${(process.env.DARTH_AUTH_INTERNAL_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '')}/api/introspect`;

/** Module that grants access to this app at all (SPEC §1 / §3.3). */
export const MEETINGS_MODULE = 'meetings';

export type CliScope = 'read' | 'readwrite' | 'admin';

/** A resolved human caller — browser session or darth-cli token. */
export type DarthIdentity = {
  kind: 'session' | 'user';
  userId: string;
  email: string;
  name?: string;
  /** Flat module names from darth-auth (`meetings`, `access`, …). */
  modules: string[];
  /** Per-service CLI scope; only meaningful for `kind:'user'` (dth_). */
  scope: CliScope;
  provider?: string;
  expiresAt?: string;
};

/** A resolved delegated-app token (dapp_). No user identity. */
export type AppIdentity = { kind: 'app'; app: string };

export type ResolvedToken = DarthIdentity | AppIdentity;

/** Back-compat alias — the dth_ shape older call sites imported. */
export type CliIdentity = DarthIdentity;

const cache = new Map<string, { at: number; identity: ResolvedToken | null }>();
const TTL = 60_000;
const MAX_ENTRIES = 500;

export function getCliBearer(headerValue: string | null): string | null {
  const m = /^Bearer\s+(dth_[A-Za-z0-9]{20,})$/.exec(headerValue || '');
  return m ? m[1] : null;
}

export function getAppBearer(headerValue: string | null): string | null {
  const m = /^Bearer\s+(dapp_[A-Za-z0-9_-]{20,})$/.exec(headerValue || '');
  return m ? m[1] : null;
}

/** Any bearer darth-auth could resolve (dth_ or dapp_), or null. */
export function getDarthBearer(headerValue: string | null): string | null {
  return getCliBearer(headerValue) ?? getAppBearer(headerValue);
}

export function isSessionValue(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^dss_[A-Za-z0-9_-]{20,}$/.test(value);
}

function toScope(v: unknown): CliScope {
  return v === 'admin' ? 'admin' : v === 'readwrite' ? 'readwrite' : 'read';
}

function toModules(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string') : [];
}

/**
 * Resolve any darth credential value via introspection. `null` = inactive,
 * revoked, expired, disabled user, malformed, or introspection unreachable
 * (the last is not cached).
 */
export async function resolveDarthToken(token: string): Promise<ResolvedToken | null> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL) return hit.identity;
  let identity: ResolvedToken | null = null;
  try {
    const res = await fetch(INTROSPECT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `service` makes darth-auth resolve `scope` for THIS service — dth_
      // tokens carry per-service access (tasks vs artifacts vs meetings).
      body: JSON.stringify({ token, service: MEETINGS_MODULE }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.active) {
        if (data.kind === 'app' && data.app) {
          identity = { kind: 'app', app: String(data.app) };
        } else if (data.userId && data.email) {
          identity = {
            kind: data.kind === 'session' || token.startsWith('dss_') ? 'session' : 'user',
            userId: String(data.userId),
            email: String(data.email).toLowerCase(),
            name: typeof data.name === 'string' ? data.name : undefined,
            modules: toModules(data.modules),
            scope: toScope(data.scope),
            provider: typeof data.provider === 'string' ? data.provider : undefined,
            expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : undefined,
          };
        }
      }
    }
  } catch {
    // introspection unreachable → treat as invalid, but don't cache a transient failure
    return null;
  }
  cache.set(token, { at: Date.now(), identity });
  if (cache.size > MAX_ENTRIES) {
    for (const [k, v] of cache) if (Date.now() - v.at > TTL) cache.delete(k);
  }
  return identity;
}

/** dth_ only — the historical entry point, kept for call sites that want a human. */
export async function resolveCliToken(token: string): Promise<DarthIdentity | null> {
  const id = await resolveDarthToken(token);
  return id && id.kind !== 'app' ? id : null;
}

/** Resolve a `darth_session` cookie value (dss_…). */
export async function resolveSession(value: string | null | undefined): Promise<DarthIdentity | null> {
  if (!isSessionValue(value)) return null;
  const id = await resolveDarthToken(value);
  return id && id.kind !== 'app' ? id : null;
}

/** SPEC §3.3: may this identity use Darth Meetings at all? */
export function hasMeetingsAccess(id: Pick<DarthIdentity, 'modules'> | null | undefined): boolean {
  return !!id && id.modules.includes(MEETINGS_MODULE);
}

export const NO_ACCESS_MESSAGE =
  'no access to meetings — ask a darth admin (admin.darth-internal.trames.io)';
