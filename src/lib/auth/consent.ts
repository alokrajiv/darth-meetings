/**
 * Human-approved consents (Darth "consents", CONTRACT §4 — the member
 * verification contract). A darth-cli caller that changes account settings
 * must carry a consent the human approved on darth-auth:
 *
 *   x-darth-consent-id: dcon_…          the approved consent's id
 *   x-darth-consent:    <text as typed> the sentence the human approved
 *   x-darth-run:        <run id>?       forwarded to auth for its audit row
 *
 * `requireConsent` checks the headers' shape (400 consent_required, with the
 * ready `darth-cli consent request …` command), asks darth-auth
 * `POST {DARTH_AUTH_INTERNAL_URL}/api/consents/verify` (5 s; anything but a
 * clean 200 answer → 503 consent_unverifiable, fail closed), and turns an
 * `ok:false` into 409 consent_refused carrying auth's reason / text / scope.
 * Verify is never cached: every gated request is one use of the consent.
 *
 * Only darth-cli (dth_) callers are gated — the web UI (cookie) changes the
 * same settings with the human at the keyboard, so `gateCliSettingsWrite`
 * lets a caller without `cliScope` straight through.
 */
import { NextResponse } from 'next/server';

export const CONSENT_ID_RE = /^dcon_[a-hj-km-np-z2-9]{12}$/;

export const MEETINGS_SERVICE = 'meetings';
export const SETTINGS_ACTION = 'settings';
/** `meetings:settings` has no target (catalogue kind `none` → literal `-`). */
export const NO_TARGET = '-';

const VERIFY_TIMEOUT_MS = 5_000;

export interface ConsentScope {
  service: string;
  action: string;
  target: string;
}

export interface ConsentBlock extends ConsentScope {
  suggestedText: string;
  request: string;
}

export interface VerifiedConsent {
  id: string;
  text: string;
  expiresAt?: string;
  usesLeft?: number | null;
}

export type ConsentOutcome =
  | { ok: true; consent: VerifiedConsent }
  | { ok: false; response: NextResponse };

/** Read at call time so tests (and a restarted env) see the current value. */
function verifyUrl(): string {
  const base = (process.env.DARTH_AUTH_INTERNAL_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');
  return `${base}/api/consents/verify`;
}

/** POSIX single-quote a value for the printed shell command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function consentBlock(scope: ConsentScope, suggestedText: string): ConsentBlock {
  const text = suggestedText.slice(0, 200);
  return {
    ...scope,
    suggestedText: text,
    request:
      `darth-cli consent request --service ${scope.service} --action ${scope.action}` +
      ` --target ${scope.target} --text ${shellQuote(text)}`,
  };
}

function refusalText(reason: string, id: string, authText?: string, scope?: Partial<ConsentScope>): string {
  switch (reason) {
    case 'unknown':
      return `consent ${id} is not known to darth-auth — request one with the command below`;
    case 'not_yours':
      return `consent ${id} belongs to another user`;
    case 'pending':
      return `consent ${id} is still waiting for the human to approve it on darth-auth`;
    case 'denied':
      return `consent ${id} was denied by the human — stop and ask them`;
    case 'revoked':
      return `consent ${id} was revoked by the human — stop and ask them`;
    case 'expired':
      return `consent ${id} has expired — request a new one`;
    case 'exhausted':
      return `consent ${id} has no uses left — request a new one`;
    case 'scope_mismatch':
      return (
        `consent ${id} was approved for ${scope?.service ?? '?'}:${scope?.action ?? '?'} ` +
        `(target ${scope?.target ?? '?'}), not for this action`
      );
    case 'text_mismatch':
      return (
        `the consent text does not match what the human approved` +
        (authText ? ` — they approved: "${authText}"; re-run with exactly that text` : '')
      );
    default:
      return `consent ${id} was refused by darth-auth (${reason})`;
  }
}

/**
 * CONTRACT §4 steps 1-4. `userId` is the introspected dth_ user. On `ok:true`
 * the caller proceeds (and records `consent.id` where it keeps provenance).
 */
export async function requireConsent(
  request: Request,
  opts: ConsentScope & { userId: string; suggestedText: string }
): Promise<ConsentOutcome> {
  const scope: ConsentScope = { service: opts.service, action: opts.action, target: opts.target };
  const block = consentBlock(scope, opts.suggestedText);
  const id = (request.headers.get('x-darth-consent-id') || '').trim();
  const text = request.headers.get('x-darth-consent') || '';
  if (!CONSENT_ID_RE.test(id) || !text.trim()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'this action needs a human-approved consent', code: 'consent_required', consent: block },
        { status: 400 }
      ),
    };
  }

  const run = request.headers.get('x-darth-run') || undefined;
  const unverifiable = () => ({
    ok: false as const,
    response: NextResponse.json(
      {
        error: 'consent could not be verified (darth-auth unreachable) — retry',
        code: 'consent_unverifiable',
      },
      { status: 503 }
    ),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    const res = await fetch(verifyUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, text, ...scope, userId: opts.userId, ...(run ? { run } : {}) }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return unverifiable();
    data = await res.json();
  } catch {
    return unverifiable();
  }

  if (data?.ok === true && data.consent && typeof data.consent === 'object') {
    return {
      ok: true,
      consent: {
        id: String(data.consent.id ?? id),
        text: String(data.consent.text ?? text),
        expiresAt: typeof data.consent.expiresAt === 'string' ? data.consent.expiresAt : undefined,
        usesLeft: typeof data.consent.usesLeft === 'number' ? data.consent.usesLeft : null,
      },
    };
  }
  if (data?.ok !== false || typeof data.reason !== 'string') return unverifiable();

  const reason: string = data.reason;
  const authText = typeof data.text === 'string' ? data.text : undefined;
  const authScope = data.scope && typeof data.scope === 'object' ? (data.scope as Partial<ConsentScope>) : undefined;
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: refusalText(reason, id, authText, authScope),
        code: 'consent_refused',
        reason,
        ...(authText !== undefined ? { text: authText } : {}),
        ...(authScope ? { scope: authScope } : {}),
        consent: block,
      },
      { status: 409 }
    ),
  };
}

export type SettingsArea = 'auto-sync' | 'notifications' | 'offline prefs';

/**
 * Who the suggested sentence names: the first word of the caller's mailbox,
 * capitalised (`alok@trames.sg` → `Alok`, `ivan.tan@…` → `Ivan`). Email, not
 * display name, so the darth-cli subcommand (which knows only the email)
 * prints the identical sentence before it ever reaches the server.
 */
export function askerName(email: string): string {
  const first = (email.split('@')[0] || '').split(/[._+-]/)[0] || '';
  return first ? first[0].toUpperCase() + first.slice(1) : 'the user';
}

export function settingsSuggestedText(area: SettingsArea, email: string): string {
  return `Change my Darth Meetings settings (${area}) as ${askerName(email)} asked`;
}

/**
 * The `meetings:settings` gate for the account-settings write routes
 * (auto-sync, notify-prefs, offline prefs). Cookie (web) callers pass
 * untouched; a darth-cli (dth_) caller needs a verified consent. Returns the
 * refusal response, or null to proceed.
 */
export async function gateCliSettingsWrite(
  ctx: { request: Request; user: { userId: string; email: string }; cliScope?: string },
  area: SettingsArea
): Promise<NextResponse | null> {
  if (!ctx.cliScope) return null;
  const out = await requireConsent(ctx.request, {
    service: MEETINGS_SERVICE,
    action: SETTINGS_ACTION,
    target: NO_TARGET,
    userId: ctx.user.userId,
    suggestedText: settingsSuggestedText(area, ctx.user.email),
  });
  if (!out.ok) return out.response;
  // meetings keeps no audit table for prefs — the log line is the provenance.
  console.info(
    `[consent] meetings:settings (${area}) by ${ctx.user.email} under ${out.consent.id}` +
      (out.consent.usesLeft != null ? ` (${out.consent.usesLeft} use(s) left)` : '')
  );
  return null;
}
