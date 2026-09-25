import 'server-only';
import type { TranscriptRow } from '@/db-ops/transcripts';
import { recorderRowForRecording, type RecorderCall } from '@/db-ops/recorder';
import { identityForUser } from '@/db-ops/transcript-activity';
import { findPeopleByEmails } from '@/db-ops/people';
import {
  callCounterpart,
  cleanCallTitle,
  describeCallKind,
  isOneToOneCall,
} from '@/lib/call-title';

/**
 * Who was on a recorded call, as far as the recorder and the calendar know —
 * the ROSTER the speaker passes read.
 *
 * Two readers (2026-09-25, transcript 973 — a WhatsApp call with Yadu where
 * his 0.77 voice match was dropped as ambiguous and the ID pass then guessed
 * a stranger):
 *   - the voiceprint margin guard breaks a tie in favour of a candidate who
 *     is on the roster (`resolveMarginByRoster`);
 *   - the speaker-ID pass gets a RECORDING CONTEXT block saying whose call it
 *     was, so a one-to-one call's two voices are named from the title, not
 *     guessed from garbled words.
 *
 * Sources, all owner-scoped: the recorder registry row behind
 * `gmeet_context.fromRecording.recordingId` (its `call.title` is the window
 * title the tray saw — "<contact> - WhatsApp voice call"), the owner's own
 * identity (they recorded it, their mic is the `eng` track), and the
 * calendar invite's attendees resolved through the directory. Best-effort:
 * every lookup failure degrades to "no context", never to an error.
 */
export interface RecordingCallContext {
  /** The recording owner — the person whose Mac made the recording. */
  owner: { name: string | null; email: string | null };
  /** The tray's call record, when the meeting came from a tray recording. */
  call: RecorderCall | null;
  /** The other party of a one-to-one call (WhatsApp/FaceTime), from the title. */
  counterpart: string | null;
  /** Everyone we can name: owner, counterpart, invitees (directory spellings). */
  roster: string[];
}

export async function recordingCallContext(row: TranscriptRow): Promise<RecordingCallContext> {
  const roster: string[] = [];
  const push = (name: string | null | undefined) => {
    const n = (name ?? '').trim();
    if (n && !roster.some((r) => r.toLowerCase() === n.toLowerCase())) roster.push(n);
  };

  let owner: RecordingCallContext['owner'] = { name: null, email: null };
  try {
    const me = await identityForUser(row.user_id);
    owner = { name: me?.name ?? null, email: me?.email ?? null };
  } catch (err) {
    console.warn('[call-context] owner identity lookup failed (continuing):', err);
  }

  let call: RecorderCall | null = null;
  const recordingId = row.gmeet_context?.fromRecording?.recordingId;
  if (recordingId) {
    try {
      call = (await recorderRowForRecording(row.user_id, recordingId))?.call ?? null;
    } catch (err) {
      console.warn('[call-context] recorder row lookup failed (continuing):', err);
    }
  }
  const counterpart = callCounterpart(call);

  // Names through the directory where we have e-mails (attendees, the owner):
  // the enrolled voiceprints carry directory spellings, so should the roster.
  const emails = [
    owner.email,
    ...(row.gmeet_context?.attendees ?? []).map((a) => a.email),
    ...(row.gmeet_context?.actuals?.participants ?? []).map((p) => p.email),
  ].filter((e): e is string => !!e);
  const displayNames = (row.gmeet_context?.actuals?.participants ?? [])
    .filter((p) => !p.email && p.displayName)
    .map((p) => p.displayName!);
  if (emails.length > 0) {
    try {
      const dir = await findPeopleByEmails(emails);
      const ownerHit = owner.email ? dir.get(owner.email.trim().toLowerCase()) : undefined;
      if (ownerHit?.name) owner = { ...owner, name: ownerHit.name };
      for (const e of emails) push(dir.get(e.trim().toLowerCase())?.name);
    } catch (err) {
      console.warn('[call-context] directory lookup failed (continuing):', err);
    }
  }
  push(owner.name);
  push(counterpart);
  for (const n of displayNames) push(n);
  for (const a of row.gmeet_context?.attendees ?? []) push(a.name);

  return { owner, call, counterpart, roster };
}

/**
 * The RECORDING CONTEXT block for the speaker-ID prompt, or '' when there is
 * nothing a title/roster can add (no tray call record).
 */
export function recordingContextBlock(ctx: RecordingCallContext, meetingTitle: string | null): string {
  if (!ctx.call) return '';
  const kind = describeCallKind(ctx.call);
  const title = cleanCallTitle(ctx.call.title);
  const owner = ctx.owner.name
    ? `${ctx.owner.name}${ctx.owner.email ? ` <${ctx.owner.email}>` : ''}`
    : ctx.owner.email ?? 'the recording owner';
  const lines: string[] = [];
  lines.push(
    `RECORDING CONTEXT: this audio was captured on ${owner}'s Mac by Darth Recorder during a ${kind}` +
      (title ? ` whose window was titled "${title}"` : '') +
      `. ${ctx.owner.name ?? 'The owner'} is therefore one of the speakers (their microphone was recorded directly; everyone else came through the call).`
  );
  if (isOneToOneCall(ctx.call.kind) && ctx.counterpart) {
    lines.push(
      `A ${kind} is one-to-one: the other voice is almost certainly the contact the title names, "${ctx.counterpart}" ` +
        `(the owner's address-book name for them — find the directory spelling with search_people and use that). ` +
        `Treat this as strong evidence; only depart from it if the transcript plainly shows a third person or a different person.`
    );
  } else if (ctx.roster.length > 1) {
    lines.push(`People known to be on this call: ${ctx.roster.join(', ')}.`);
  }
  if (meetingTitle && cleanCallTitle(meetingTitle) !== title) {
    lines.push(`The meeting is titled "${meetingTitle.trim()}".`);
  }
  return lines.join('\n') + '\n\n';
}
