/**
 * Slack DM notifications via the darth-plagueis notify endpoint.
 *
 * The endpoint is a dumb pipe: WE own the message body (Slack mrkdwn);
 * plagueis resolves email → Slack DM and appends a non-spoofable
 * "via darth-meetings" attribution derived from our app token.
 *
 * Auth: DARTH_APP_TOKEN (dapp_… service credential, minted on darth-auth by
 * the operator — see the darth-auth repo: ~/crp-workspace/darth/auth/admin-app-token.ts).
 * Missing token → notifications are silently skipped (feature off), because
 * a share must never fail on notification plumbing.
 */

import { isNotifyKindEnabled, type NotifyKind } from '@/db-ops/notify-prefs';

const NOTIFY_URL = process.env.DARTH_NOTIFY_URL || 'https://tasks.darth-internal.trames.io/api/notify';

/** Base URL for links inside DMs (and the settings-page footer). */
export const APP_URL = process.env.MW_PUBLIC_URL || 'https://meetings.darth-internal.trames.io';

export interface DarthDmInput {
  toEmail: string;
  /** Slack mrkdwn. Keep it one short line + a link; plagueis caps at 3800. */
  text: string;
  /** Idempotency key — same key never DMs twice (e.g. `mw-share:<id>:<email>`). */
  dedupeKey?: string;
  /** SSO uuid of the human whose action triggered this (audit only). */
  onBehalfOf?: string;
}

export async function sendDarthDm(input: DarthDmInput): Promise<void> {
  const token = process.env.DARTH_APP_TOKEN;
  if (!token) return;
  try {
    const res = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(input.onBehalfOf ? { 'x-on-behalf-of': input.onBehalfOf } : {}),
      },
      body: JSON.stringify({
        to_email: input.toEmail,
        text: input.text,
        ...(input.dedupeKey ? { dedupe_key: input.dedupeKey } : {}),
      }),
      signal: AbortSignal.timeout(4000),
    });
    const data = (await res.json().catch(() => null)) as {
      delivered?: boolean;
      unroutable?: boolean;
      deduped?: boolean;
      error?: string;
    } | null;
    if (!res.ok) {
      console.error(`[darth-notify] ${res.status} for ${input.toEmail}: ${data?.error ?? 'unknown'}`);
    } else if (data?.unroutable) {
      // External email with no Slack mapping — expected, not an error.
      console.log(`[darth-notify] unroutable (no Slack): ${input.toEmail}`);
    }
  } catch (e) {
    console.error(`[darth-notify] failed for ${input.toEmail}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Preference-aware DM: checks the recipient's notify_prefs for `kind` and
 * appends a settings-page footer so every DM links to where it can be turned
 * off. Use this (not sendDarthDm directly) for every recurring notification
 * kind; raw sendDarthDm remains for one-off plumbing.
 */
export async function notifyUser(
  input: DarthDmInput & { kind: NotifyKind }
): Promise<void> {
  if (!process.env.DARTH_APP_TOKEN) return;
  if (!(await isNotifyKindEnabled(input.toEmail, input.kind))) return;
  await sendDarthDm({
    ...input,
    text: `${input.text}\n<${APP_URL}/settings#notifications|⚙ notification settings>`,
  });
}
