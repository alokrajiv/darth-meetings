'use client';

import { FileText, Headphones, ListTree, Users } from 'lucide-react';
import type { MarkdownHeading } from '@/lib/markdown-headings';
import type { TranscriptSegment } from '@/lib/format';

interface TranscriptOutlineProps {
  /** Total audio duration in seconds. When null, the time-chunk list is suppressed. */
  durationSec: number | null;
  hasNotes: boolean;
  hasSpeakers: boolean;
  /** Headings extracted from the Notes markdown — rendered as a tree under "Notes". */
  notesHeadings?: MarkdownHeading[];
  /** Current playhead in seconds — used to highlight which 1/5 chunk is active.
   *  Pass null to disable chunk highlighting entirely (e.g. when the user
   *  hasn't scrolled into the transcript yet and audio hasn't been played). */
  currentTimeSec: number | null;
  /** Seek the audio player and scroll to the transcript section. */
  onJumpToSeconds: (s: number) => void;
  /** Anchor id of the section the user is currently scrolled into; used
   *  to highlight the matching link in the outline. */
  activeAnchor?: string | null;
  /** AI-suggested topical segments. When present, these replace the
   *  evenly-spaced timestamp chunks with named jump points. */
  segments?: TranscriptSegment[] | null;
}

const CHUNKS = 5;

function formatHMS(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Notion-style right-rail outline. Sticky-positioned by the parent. Lists
 * the page's main sections plus 5 evenly-spaced timestamp jumps inside
 * the transcript so long meetings are navigable from one click.
 */
export function TranscriptOutline({
  durationSec,
  hasNotes,
  hasSpeakers,
  notesHeadings = [],
  currentTimeSec,
  onJumpToSeconds,
  activeAnchor,
  segments,
}: TranscriptOutlineProps) {
  const isActive = (id: string) => activeAnchor === id;
  // Normalise heading levels so the tree starts at indent 0 even when the
  // notes use h2 as their top level.
  const minLevel = notesHeadings.length
    ? Math.min(...notesHeadings.map((h) => h.level))
    : 1;
  const chunkStarts =
    durationSec && durationSec > 0
      ? Array.from({ length: CHUNKS }, (_, i) => Math.floor((durationSec * i) / CHUNKS))
      : [];
  const activeChunk =
    durationSec && durationSec > 0 && currentTimeSec != null
      ? Math.min(Math.floor((currentTimeSec / durationSec) * CHUNKS), CHUNKS - 1)
      : -1;

  return (
    <nav
      aria-label="Transcript outline"
      className="text-sm space-y-3 rounded-md border bg-card/40 p-3"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <ListTree className="h-3 w-3" />
        On this page
      </div>

      <ul className="space-y-1">
        {hasNotes && (
          <li>
            <a
              href="#notes"
              className={`flex items-center gap-1.5 rounded px-2 py-1 transition-colors ${
                isActive('notes')
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <FileText className="h-3.5 w-3.5" />
              Notes
            </a>
            {notesHeadings.length > 0 && (
              <ul className="ml-4 mt-0.5 border-l border-muted pl-2 space-y-0.5">
                {notesHeadings.map((h, i) => (
                  <li key={`${h.slug}-${i}`}>
                    <a
                      href={`#${h.slug}`}
                      className={`block truncate rounded px-2 py-0.5 text-xs transition-colors ${
                        isActive(h.slug)
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                      style={{ paddingLeft: `${(h.level - minLevel) * 0.6 + 0.5}rem` }}
                      title={h.text}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )}
        {hasSpeakers && (
          <li>
            <a
              href="#speakers"
              className={`flex items-center gap-1.5 rounded px-2 py-1 transition-colors ${
                isActive('speakers')
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              Speakers
            </a>
          </li>
        )}
        <li>
          <a
            href="#transcript"
            className={`flex items-center gap-1.5 rounded px-2 py-1 transition-colors ${
              isActive('transcript')
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Headphones className="h-3.5 w-3.5" />
            Transcript
          </a>
        </li>
      </ul>

      {segments && segments.length > 0 ? (
        <div className="ml-2 border-l border-muted pl-3 space-y-0.5">
          {segments.map((seg, i) => {
            const startSec = seg.start_ms / 1000;
            const endSec = segments[i + 1] ? segments[i + 1]!.start_ms / 1000 : Infinity;
            const isActiveSeg =
              currentTimeSec != null && currentTimeSec >= startSec && currentTimeSec < endSec;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onJumpToSeconds(startSec)}
                className={`flex w-full items-baseline gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors ${
                  isActiveSeg
                    ? 'bg-muted text-foreground font-semibold'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                title={`Jump to ${formatHMS(startSec)} — ${seg.title}`}
              >
                <span className="w-8 shrink-0 text-right font-mono text-[10px] opacity-70">
                  {formatHMS(startSec)}
                </span>
                <span className="min-w-0 flex-1 truncate">{seg.title}</span>
              </button>
            );
          })}
        </div>
      ) : chunkStarts.length > 0 ? (
        <div className="ml-2 border-l border-muted pl-3 space-y-0.5">
          {chunkStarts.map((s, i) => {
            const isActive = i === activeChunk;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onJumpToSeconds(s)}
                className={`block w-full text-left rounded px-2 py-1 text-xs font-mono transition-colors ${
                  isActive
                    ? 'bg-muted text-foreground font-semibold'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                title={`Jump to ${formatHMS(s)}`}
              >
                {formatHMS(s)}
              </button>
            );
          })}
        </div>
      ) : null}
    </nav>
  );
}
