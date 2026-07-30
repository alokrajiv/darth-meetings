'use client';

import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { type PickerPerson } from '@/components/user-picker';
import { SpeakerPreviewDialog } from '@/components/speaker-preview-dialog';
import { ChevronDown, ChevronUp, Pencil, Sparkles, Users } from 'lucide-react';
import type { SpeakerLabel, SpeakerSuggestionMap } from '@/lib/format';
import { defaultSpeakerLabel, speakerColorVar } from '@/lib/speaker-display';

interface Utterance {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

interface SpeakerSummaryPanelProps {
  utterances: Utterance[];
  speakerLabels: SpeakerLabel[];
  onSave: (
    originalSpeaker: string,
    patch: { customName?: string; description?: string }
  ) => void;
  /** Disables editing when false (the Edit button is hidden). */
  canEdit: boolean;
  /** Forwarded into the preview/edit dialog for the add-to-access flow. */
  onPickPerson: (person: PickerPerson) => void;
  onRequestCreatePerson: (originalSpeaker: string, name: string) => void;
  /** /api/transcripts/[id]/audio — voice samples in the dialog. Null = no audio. */
  audioSrc: string | null;
  /** Optional collapse state — when set, the card header becomes a toggle. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Voiceprint auto-detection results keyed by original speaker. */
  suggestions?: SpeakerSuggestionMap;
  /** Run voiceprint matching on demand ("Guess names" button). */
  onGuessNames?: () => void;
  guessingNames?: boolean;
}

/**
 * Speakers card: a compact two-column grid of single-line rows — color dot,
 * name, line count, inline auto-detected suggestion, and a hover Edit pencil
 * that opens the speaker dialog where you cycle speakers, hear their
 * distinctive moments, and set names + context.
 */
export function SpeakerSummaryPanel({
  utterances,
  speakerLabels,
  onSave,
  canEdit,
  onPickPerson,
  onRequestCreatePerson,
  audioSrc,
  collapsed,
  onToggleCollapse,
  suggestions,
  onGuessNames,
  guessingNames,
}: SpeakerSummaryPanelProps) {
  const [editSpeaker, setEditSpeaker] = useState<string | null>(null);
  const uniqueSpeakers = useMemo(
    () => Array.from(new Set(utterances.map((u) => u.speaker))).sort(),
    [utterances]
  );

  const utteranceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const u of utterances) {
      counts[u.speaker] = (counts[u.speaker] ?? 0) + 1;
    }
    return counts;
  }, [utterances]);

  const titleInner = (
    <>
      <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-[13px] font-semibold">Speakers</span>
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
        {uniqueSpeakers.length}
      </span>
    </>
  );

  return (
    <>
      <Card>
        <CardHeader className="px-4 pt-3 pb-2">
          <div className="flex items-center gap-2">
            {onToggleCollapse ? (
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-expanded={!collapsed}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {titleInner}
                {collapsed ? (
                  <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2">{titleInner}</div>
            )}
            {canEdit && onGuessNames && (
              <button
                type="button"
                onClick={onGuessNames}
                disabled={guessingNames}
                title="Match each voice against known people (local voiceprints — no AI call)"
                className="flex shrink-0 items-center gap-1 rounded-md border border-primary/30 px-2 py-1 text-[11px] text-primary transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Sparkles className={`h-3 w-3 ${guessingNames ? 'animate-pulse' : ''}`} />
                {guessingNames ? 'Listening…' : 'Guess names'}
              </button>
            )}
          </div>
        </CardHeader>
        {!collapsed && (
          <CardContent className="px-4 pb-4">
            <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
              {uniqueSpeakers.map((speaker) => {
                const mapping = speakerLabels.find((m) => m.originalSpeaker === speaker);
                const name = mapping?.customName?.trim() ?? '';
                const description = mapping?.description?.trim() ?? '';
                const count = utteranceCounts[speaker] ?? 0;
                const suggestion = !name ? suggestions?.[speaker] : undefined;
                return (
                  <div
                    key={speaker}
                    className="group flex h-9 items-center gap-2 rounded-md px-2 hover:bg-muted/60"
                    onDoubleClick={() => canEdit && setEditSpeaker(speaker)}
                    title={description || (canEdit ? 'Double-click to edit' : undefined)}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: speakerColorVar(speaker) }}
                    />
                    <span
                      className={`truncate text-sm ${
                        name ? 'font-medium' : 'italic text-muted-foreground'
                      }`}
                    >
                      {name || defaultSpeakerLabel(speaker)}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      · {count} {count === 1 ? 'line' : 'lines'}
                    </span>
                    {suggestion && (
                      <>
                        <span
                          className="flex min-w-0 items-center gap-1 text-xs text-primary"
                          title={
                            suggestion.evidence
                              ? `Evidence: ${suggestion.evidence}`
                              : suggestion.source !== 'context'
                                ? `${Math.round(suggestion.confidence * 100)}% voice match`
                                : undefined
                          }
                        >
                          <Sparkles className="h-3 w-3 shrink-0" />
                          <span className="truncate">{suggestion.name}?</span>
                        </span>
                        {canEdit && (
                          <>
                            <button
                              type="button"
                              onClick={() => onSave(speaker, { customName: suggestion.name })}
                              className="shrink-0 rounded border border-primary/30 px-1.5 py-0.5 text-[11px] text-primary transition-colors hover:bg-accent"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => onRequestCreatePerson(speaker, suggestion.name)}
                              title="Confirm and add this person to the people directory"
                              className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              + Person
                            </button>
                          </>
                        )}
                      </>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => setEditSpeaker(speaker)}
                        className="ml-auto shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                        title="Edit name & context (and preview this voice)"
                        aria-label={`Edit speaker ${defaultSpeakerLabel(speaker)}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        )}
      </Card>

      {editSpeaker && (
        <SpeakerPreviewDialog
          open
          onOpenChange={(v) => !v && setEditSpeaker(null)}
          initialSpeaker={editSpeaker}
          speakers={uniqueSpeakers}
          utterances={utterances}
          speakerLabels={speakerLabels}
          audioSrc={audioSrc}
          canEdit={canEdit}
          onSave={onSave}
          onPickPerson={onPickPerson}
          onRequestCreatePerson={onRequestCreatePerson}
        />
      )}
    </>
  );
}
