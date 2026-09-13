#!/usr/bin/env bun
/**
 * Stub darth-auth introspect server for local verification of the auth
 * cutover (SPEC §3 + §4.2). Zero deps; plain node:http so it runs under
 * `bun` or `node` and type-checks with the app's `types:["node"]` tsconfig.
 *
 *   bun scripts/stub-introspect.ts [port=8791]
 *
 * Answers POST /api/introspect for a fixed set of credentials. The value's
 * SUFFIX decides the reply so a curl can name what it wants (suffixes are
 * alphanumeric because real dth_ tokens are — the app's bearer regex is strict):
 *
 *   dss_<…>FULL       session,   modules [meetings, tasks]
 *   dss_<…>NOMEET     session,   modules [tasks]            (no `meetings`)
 *   dth_<…>RW         cli token, modules [meetings], scope readwrite
 *   dth_<…>RO         cli token, modules [meetings], scope read
 *   dth_<…>NOMEET     cli token, modules [],         scope readwrite (the closed bypass)
 *   dapp_<…>          app token  { active:true, kind:'app', app:'stub-app' }
 *   anything else     { active:false }
 *
 * GET /login and GET /logout echo their query so the redirect targets can
 * be followed in a browser during a dev run.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const port = Number(process.argv[2] || process.env.STUB_PORT || 8791);
const log: Array<{ at: string; token: string; service?: string; reply: unknown }> = [];

function reply(token: string, service?: string) {
  // userId must be uuid-shaped: transcript rows key on a uuid column, so the app's
  // read-only listing runs (and returns nothing) instead of 500ing on a cast.
  const base = { userId: '00000000-0000-4000-8000-00000000d0d0', email: 'stub.user@trames.sg', name: 'Stub User', provider: 'dev' };
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  if (token.startsWith('dss_')) {
    if (token.endsWith('FULL')) return { active: true, kind: 'session', ...base, modules: ['meetings', 'tasks'], expiresAt };
    if (token.endsWith('NOMEET')) return { active: true, kind: 'session', ...base, modules: ['tasks'], expiresAt };
    return { active: false };
  }
  if (token.startsWith('dth_')) {
    const scopes: Record<string, string> = {
      tasks: 'readwrite',
      artifacts: 'read',
      meetings: token.endsWith('RO') ? 'read' : 'readwrite',
    };
    const scope = service ? scopes[service] ?? 'read' : undefined;
    if (token.endsWith('RW') || token.endsWith('RO'))
      return { active: true, kind: 'user', ...base, scope, scopes, modules: ['meetings'], expiresAt };
    if (token.endsWith('NOMEET'))
      return { active: true, kind: 'user', ...base, scope, scopes, modules: [], expiresAt };
    return { active: false };
  }
  if (token.startsWith('dapp_')) return { active: true, kind: 'app', app: 'stub-app' };
  return { active: false };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (req.method === 'POST' && url.pathname === '/api/introspect') {
    let body: { token?: string; service?: string } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      /* empty/invalid body → inactive */
    }
    const token = String(body.token ?? '');
    const out = reply(token, body.service);
    log.push({ at: new Date().toISOString(), token: token.slice(0, 16) + '…', service: body.service, reply: out });
    console.log(
      `[stub] introspect ${token.slice(0, 20)}… service=${body.service ?? '-'} → ${JSON.stringify(out).slice(0, 90)}`
    );
    return json(res, 200, out);
  }
  if (url.pathname === '/login' || url.pathname === '/logout') {
    return json(res, 200, { stub: url.pathname, returnTo: url.searchParams.get('returnTo') });
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true, calls: log.length });
  if (url.pathname === '/_log') return json(res, 200, log);
  res.writeHead(404).end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[stub] darth-auth introspect stub on http://127.0.0.1:${port}`);
});
