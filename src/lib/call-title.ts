/**
 * What the tray's call record says about WHO was on a recorded call. Pure,
 * client-safe; read by the voiceprint margin guard and the speaker-ID pass
 * (both server-side) and unit-tested on its own.
 *
 * Why (2026-09-25, transcript 973): a WhatsApp voice call with Yadu was
 * recorded with `call.title = "Yadu N M - WhatsApp voice call"`, the
 * voiceprint pass scored him 0.77 but threw the match away as ambiguous
 * (a contaminated rival print at 0.72), and the ID pass — never told whose
 * call it was — guessed a third person at 0.3. The recorder knew the answer
 * all along; nobody downstream was reading it.
 */

/** The subset of the registry's `call` json that names people. */
export interface CallHints {
  kind?: string | null;
  app?: string | null;
  title?: string | null;
}

/** Invisible marks WhatsApp puts in its window titles (U+200E etc.). */
const INVISIBLE = new RegExp(
  '[' +
    String.fromCharCode(0x200b) + '-' + String.fromCharCode(0x200f) + // zero-width + bidi marks (U+200E LRM is WhatsApp's)
    String.fromCharCode(0x2028) + '-' + String.fromCharCode(0x202e) + // line/paragraph separators, bidi embeddings
    String.fromCharCode(0x2060) + '-' + String.fromCharCode(0x206f) + // word joiner, invisible operators
    String.fromCharCode(0xfeff) + // BOM / zero-width no-break space
  ']',
  'g'
);

export function cleanCallTitle(title: string | null | undefined): string {
  return (title ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Call kinds that are one-to-one by construction: the recording owner and
 * exactly one other person. A Meet/Teams/Zoom/Slack call can be any size —
 * the calendar says who was there, not the window title.
 */
export function isOneToOneCall(kind: string | null | undefined): boolean {
  return kind === 'whatsapp' || kind === 'facetime';
}

/**
 * The other party of a one-to-one call, as the app names them, or null.
 *
 * WhatsApp titles its call window `"<contact> - WhatsApp voice call"` /
 * `"<contact> - WhatsApp video call"` (the contact is the user's own address
 * book name for them — usually a real name, sometimes a nickname). FaceTime
 * titles it `"<name>"` alone, or `"FaceTime"` when nobody is connected yet.
 */
export function callCounterpart(call: CallHints | null | undefined): string | null {
  if (!call) return null;
  const title = cleanCallTitle(call.title);
  if (!title) return null;
  if (call.kind === 'whatsapp') {
    const m = title.match(/^(.*?)\s+-\s+WhatsApp\s+(voice|video)\s+call$/i);
    const name = (m ? m[1]! : '').trim();
    return name && !/^whatsapp$/i.test(name) ? name : null;
  }
  if (call.kind === 'facetime') {
    return /^facetime$/i.test(title) ? null : title;
  }
  return null;
}

/** "WhatsApp voice call", "Google Meet call", … for prose. */
export function describeCallKind(call: CallHints | null | undefined): string {
  const title = cleanCallTitle(call?.title);
  if (call?.kind === 'whatsapp') {
    return /video call$/i.test(title) ? 'WhatsApp video call' : 'WhatsApp voice call';
  }
  const names: Record<string, string> = {
    teams: 'Microsoft Teams call',
    meet: 'Google Meet call',
    zoom: 'Zoom call',
    slack: 'Slack huddle',
    facetime: 'FaceTime call',
    webex: 'Webex call',
    discord: 'Discord call',
    browser: 'browser call',
  };
  return names[call?.kind ?? ''] ?? (cleanCallTitle(call?.app) ? `${cleanCallTitle(call?.app)} call` : 'call');
}
