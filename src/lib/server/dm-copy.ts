import 'server-only';
import { SCRATCH_TTL_DAYS, formatDuration } from '@/lib/format';
import { resolveMeetingByAnyTranscriptId } from '@/db-ops/meetings';
import { APP_URL } from '@/lib/server/darth-notify';

/**
 * One voice for every Slack DM Darth Meetings sends (Alok, 2026-08-30: the
 * DMs were "cheap and not creative"). Every message is built from the same
 * parts so they read as a family:
 *
 *   <emoji> *<what happened, as a headline>*
 *   *<meeting title>*  ·  Thu 28 Aug, 14:00  ·  47 min  ·  5 speakers
 *   <the substance — takeaways / who / why>
 *   <exactly one thing to do next → link>
 *
 * Keep the substance lines short: Slack is chat. `headlines()` lifts the
 * first sentence of the summary plus the top key points so a notes-ready DM
 * is useful without opening anything.
 */

export interface MeetingFacts {
  title?: string | null;
  /** ISO / Date of the meeting itself (recorded_at, event start). */
  when?: string | Date | null;
  /** Seconds. */
  duration?: number | null;
  speakerCount?: number | null;
}

const TZ = process.env.MW_DM_TZ || 'Asia/Singapore';

export function whenLine(when: string | Date | null | undefined): string | null {
  if (!when) return null;
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
  return `${day}, ${time}`;
}

/** `*Title*  ·  Thu 28 Aug, 14:00  ·  47 min  ·  5 speakers` */
export function meetingLine(m: MeetingFacts): string {
  const parts = [`*${(m.title ?? '').trim() || 'Untitled meeting'}*`];
  const w = whenLine(m.when);
  if (w) parts.push(w);
  if (m.duration && m.duration > 30) parts.push(formatDuration(Math.round(m.duration)));
  if (m.speakerCount && m.speakerCount > 0) parts.push(`${m.speakerCount} speaker${m.speakerCount === 1 ? '' : 's'}`);
  return parts.join('  ·  ');
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1).replace(/[,;:\s]+\S*$/, '') + '…';
}

/** Markdown → Slack-ish: bold stays bold, headings/links stripped. */
function plain(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * The gist of a notes markdown: first sentence of "## Summary" plus the
 * first `bullets` items of "## Key Points" (falls back to the first bullets
 * anywhere). Returns Slack lines, already prefixed.
 */
export function headlines(notes: string | null | undefined, bullets = 2): string[] {
  if (!notes) return [];
  const out: string[] = [];
  const sections = notes.split(/^##\s+/m);
  const summary = sections.find((s) => /^summary/i.test(s));
  if (summary) {
    const body = summary.replace(/^summary[^\n]*\n/i, '').trim();
    const firstPara = body.split(/\n\s*\n/)[0] ?? '';
    const firstSentence = firstPara.match(/^.+?[.!?](\s|$)/)?.[0] ?? firstPara;
    if (firstSentence.trim()) out.push(`_${clip(plain(firstSentence), 220)}_`);
  }
  const keyPoints = sections.find((s) => /^key points|^decisions|^takeaways/i.test(s)) ?? notes;
  const items = keyPoints
    .split('\n')
    .filter((l) => /^\s*[-*•]\s+/.test(l))
    .map((l) => plain(l.replace(/^\s*[-*•]\s+/, '')))
    .filter(Boolean)
    .slice(0, bullets);
  for (const it of items) out.push(`• ${clip(it, 170)}`);
  return out;
}

/** `<url|label>` — the permanent /m/<uuid> link when the ledger knows the
 * row, else the transcript URL. */
export async function openLink(assemblyaiId: string | null | undefined, label = 'Open'): Promise<string> {
  if (!assemblyaiId) return `<${APP_URL}/|${label}>`;
  const m = await resolveMeetingByAnyTranscriptId(assemblyaiId).catch(() => null);
  return m ? `<${APP_URL}/m/${m.id}|${label}>` : `<${APP_URL}/transcript/${assemblyaiId}|${label}>`;
}

export const SETTINGS_LINK = `<${APP_URL}/settings#auto-sync|Settings>`;

/** The listing, where the Trash tab lives (there is no per-tab deep link). */
export const TRASH_LINK = `<${APP_URL}/|Open the Trash tab>`;

/**
 * "Your temporary transcript was moved to the trash" (notes sweeper, after
 * the SCRATCH_TTL_DAYS auto-trash). Nothing is lost: trash is never purged
 * automatically, so the ask is simply "restore it if you still want it".
 */
export function scratchTrashedDm(m: MeetingFacts): string {
  return dm(
    `🗑 *Temporary transcript moved to the trash*`,
    meetingLine(m),
    `It was marked temporary and its ${SCRATCH_TTL_DAYS} days ran out. Nothing is deleted for good — restore it from the Trash tab whenever you need it (it stays there until you empty it) → ${TRASH_LINK}`
  );
}

/** Join the non-empty lines of a DM. */
export function dm(...lines: Array<string | null | undefined | false>): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0).join('\n');
}
