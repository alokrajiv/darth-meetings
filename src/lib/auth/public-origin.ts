import type { NextRequest } from 'next/server';

/**
 * Public origin of the current request — the ONE place absolute `returnTo`
 * URLs for darth-auth (login / logout / no-access sign-out) and the /m/<uuid>
 * redirects get their host from.
 *
 * Behind nginx on the .6 VM (`/etc/nginx/sites-available/meetings`) the
 * upstream sees `Host: $host` (the public hostname) and an nginx-owned
 * `X-Forwarded-Proto: $scheme`; `request.url`/`nextUrl` reflect the internal
 * `localhost:3002` origin, which is why the proto is taken from the forwarded
 * header. nginx does NOT set `X-Forwarded-Host` — a client-supplied one would
 * pass straight through — so that header is only honoured when
 * `DARTH_TRUST_FORWARDED_HOST=1` (set it only behind a proxy that overwrites
 * the header itself). darth-auth's same-site check on `returnTo` is the second
 * line of defence; this keeps the member side from ever emitting a foreign host.
 */
export function publicOrigin(request: NextRequest): string {
  const trustForwardedHost = process.env.DARTH_TRUST_FORWARDED_HOST === '1';
  const forwardedHost = trustForwardedHost ? request.headers.get('x-forwarded-host') : null;
  const host = (forwardedHost || request.headers.get('host') || request.nextUrl.host || 'localhost').trim();

  const fwdProto = (request.headers.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const proto =
    fwdProto === 'http' || fwdProto === 'https'
      ? fwdProto
      : request.nextUrl.protocol.replace(/:$/, '') || 'https';
  return `${proto}://${host}`;
}

/** Absolute public URL for `path` (a same-origin path like `/settings?x=1`). */
export function publicUrl(request: NextRequest, path: string): string {
  return new URL(path, publicOrigin(request)).toString();
}

/**
 * Absolute same-origin URL for a `returnTo` query value, or the origin root
 * when it is anything else. Resolves `raw` against `origin` and keeps it only
 * when the parsed origin IS `origin` — so `//evil`, `/\\evil` (the WHATWG
 * parser reads `\\` as `/` for http(s)), `https://evil` and credentials all
 * fall back to `/`. Never reflects the raw value.
 */
export function sameOriginReturnTo(raw: string | null, origin: string): string {
  const root = new URL('/', origin).toString();
  if (!raw || raw.includes('\\')) return root;
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin || u.username || u.password) return root;
    return u.toString();
  } catch {
    return root;
  }
}
