/**
 * "24-hour times everywhere" (docs/transcript-page-redesign.md §6).
 *
 * The identity block of the transcript page says when a meeting happened as
 * `Mon 21 Sep 2026 · 16:30–17:30 · 56m 45s`. These helpers are deterministic
 * (fixed English names, never the browser locale) so the page reads the same
 * on every machine and in tests. Pure, client-safe.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

export function safeDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "16:30" — always 24-hour, local time. */
export function clock24(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Mon 21 Sep 2026" — the year is always shown: a page people land on from a Slack link is read out of context. */
export function dayLabel(d: Date): string {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export interface WhenLineInput {
  /** The curated moment the meeting happened (`recorded_at`, else the event start, else `created_at`). */
  held: Date;
  /** Calendar event range, when the row is linked to one. */
  eventStart?: Date | null;
  eventEnd?: Date | null;
}

/**
 * The "when" line: the calendar range when the event is linked, on one day,
 * and agrees with the curated date (recorded_at can be set by hand and
 * wins); otherwise the curated moment.
 *   "Mon 21 Sep 2026 · 16:30–17:30"  /  "Mon 21 Sep 2026 · 16:30"
 */
export function whenLine({ held, eventStart, eventEnd }: WhenLineInput): string {
  if (eventStart && eventEnd && sameDay(eventStart, eventEnd) && sameDay(held, eventStart)) {
    return `${dayLabel(eventStart)} · ${clock24(eventStart)}–${clock24(eventEnd)}`;
  }
  return `${dayLabel(held)} · ${clock24(held)}`;
}

/** True when the calendar range is what `whenLine` shows — the tooltip then says so. */
export function usesEventRange({ held, eventStart, eventEnd }: WhenLineInput): boolean {
  return !!(eventStart && eventEnd && sameDay(eventStart, eventEnd) && sameDay(held, eventStart));
}
