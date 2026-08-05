/**
 * darth-cli bearer support: resolves `Authorization: Bearer dth_…` tokens via
 * darth-auth introspection. Same pattern as darth-plagueis' cli-auth.ts —
 * loopback hop on the VM, 60s in-process cache so bursts of CLI calls cost
 * one HTTP call per minute per token.
 *
 * The userId darth-auth returns is the clonetrooper SSO userId (darth-auth
 * verifies the same trames-auth-session JWT on device approval), so it drops
 * straight into the row-level ACLs keyed on user.userId.
 */

const INTROSPECT_URL =
  process.env.DARTH_AUTH_INTROSPECT_URL ||
  'https://auth.darth-internal.trames.io/api/introspect';

export type CliScope = 'read' | 'readwrite' | 'admin';

export type CliIdentity = {
  userId: string;
  email: string;
  scope: CliScope;
};

const cache = new Map<string, { at: number; identity: CliIdentity | null }>();
const TTL = 60_000;

export function getCliBearer(headerValue: string | null): string | null {
  const m = /^Bearer\s+(dth_[A-Za-z0-9]{20,})$/.exec(headerValue || '');
  return m ? m[1] : null;
}

export async function resolveCliToken(token: string): Promise<CliIdentity | null> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL) return hit.identity;
  let identity: CliIdentity | null = null;
  try {
    const res = await fetch(INTROSPECT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `service` makes darth-auth resolve `scope` for THIS service — tokens
      // carry per-service access (tasks vs artifacts vs meetings).
      body: JSON.stringify({ token, service: 'meetings' }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.active && data.userId && data.email) {
        const scope: CliScope =
          data.scope === 'admin' ? 'admin' : data.scope === 'readwrite' ? 'readwrite' : 'read';
        identity = { userId: data.userId, email: data.email, scope };
      }
    }
  } catch {
    // introspection unreachable → treat as invalid, but don't cache a transient failure
    return null;
  }
  cache.set(token, { at: Date.now(), identity });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at > TTL) cache.delete(k);
  }
  return identity;
}
