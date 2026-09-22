/**
 * The words both surfaces use for a calendar event we only SUSPECT
 * (docs/recorder-link-confirm-spec.md D4) and for a recording that has no
 * video (D6). Pure — the transcript page, the listing strip and any test can
 * share one sentence.
 *
 * The rule behind the copy: a suggestion must show the human BOTH halves —
 * what the recording is (a Slack call) and what the event is (a Google Meet
 * invite) — because the 2026-09-22 incident was exactly a mismatch nobody was
 * shown before it was applied.
 */
import type { SuggestedEvent } from '@/lib/format';
import type { ConferenceProvider } from '@/lib/recorder';

export function providerLabel(p: ConferenceProvider | string | null | undefined): string | null {
  switch (p) {
    case 'meet':
      return 'Google Meet';
    case 'teams':
      return 'Microsoft Teams';
    case 'zoom':
      return 'Zoom';
    case 'webex':
      return 'Webex';
    case 'slack':
      return 'Slack';
    case 'whatsapp':
      return 'WhatsApp';
    case 'facetime':
      return 'FaceTime';
    case 'discord':
      return 'Discord';
    default:
      return null;
  }
}

/** "15:30–16:30", or "15:30" when the invite has no end. */
export function occurrenceTimeRange(
  s: Pick<SuggestedEvent, 'startIso' | 'endIso'>,
  locale?: string
): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  const start = Number.isNaN(Date.parse(s.startIso)) ? null : fmt(s.startIso);
  if (!start) return '';
  const end = s.endIso && !Number.isNaN(Date.parse(s.endIso)) ? fmt(s.endIso) : null;
  return end ? `${start}–${end}` : start;
}

/**
 * The strip's sentence: «Looks like “Triton next steps!” · 15:30–16:30 ·
 * Google Meet». The actions ("Link to it" / "Not this") are the caller's.
 */
export function suggestedEventLine(s: SuggestedEvent, locale?: string): string {
  const title = s.title?.trim() || 'a meeting on your calendar';
  const bits = [occurrenceTimeRange(s, locale), providerLabel(s.provider)].filter(Boolean);
  return `Looks like “${title}”${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}

/**
 * The tooltip: the numbers behind the guess, and — the point — what the
 * recording itself was, so a Slack call against a Meet invite is obvious
 * before anyone says yes.
 */
export function suggestedEventWhy(s: SuggestedEvent): string {
  const call = providerLabel(s.callKind) ?? (s.callKind ? s.callKind : null);
  const mismatch =
    call && s.provider && s.callKind !== s.provider
      ? ` This recording is a ${call} call and that invite is ${providerLabel(s.provider)} — check before linking.`
      : '';
  return (
    `Guessed from the clock and the window title: overlap ${Math.round(s.overlap * 100)}%, ` +
    `title match ${Math.round(s.titleScore * 100)}%.` +
    (call ? ` The recording is a ${call} call.` : '') +
    mismatch +
    ' Nothing is linked or shared until you say so.'
  );
}

/**
 * D6 — why a recording has no video. The player used to show nothing at all
 * where the "Show video" toggle would be.
 */
export function noVideoNote(call: { app?: string | null; kind?: string | null } | null | undefined): string {
  const base = 'This recording has no video — the recorder captured audio only';
  const app = call?.app?.trim();
  if (!app) return `${base}.`;
  // Slack is the one we know we miss (the share watcher does not see huddle
  // screen shares yet — B's D6 investigation).
  if ((call?.kind ?? '').toLowerCase() === 'slack' || app.toLowerCase() === 'slack') {
    return `${base}, during a Slack call; screen shares in Slack are not captured yet.`;
  }
  return `${base}, during a ${app} call.`;
}
