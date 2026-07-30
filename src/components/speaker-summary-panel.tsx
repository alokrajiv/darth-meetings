'use client';

import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { type PickerPerson } from '@/components/user-picker';
import { SpeakerPreviewDialog } from '@/components/speaker-preview-dialog';
import { ChevronDown, ChevronUp, Pencil, Sparkles, Users } from 'lucide-react';
import type { SpeakerLabel, SpeakerSuggestionMap } from '@/lib/format';
import { defaultSpeakerLabel } from '@/lib/speaker-display';

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
 * Top-of-page Speakers card. Each speaker is a single line: label badge,
 * line count, name (display), and one "Edit" button. Edit opens the
 * speaker dialog where you cycle speakers, hear their distinctive moments,
 * and set names + context — all consolidated there.
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

  const titleNode = (
    <CardTitle className="flex items-center gap-2 text-base">
      <Users className="h-4 w-4" />
      Speakers
      <Badge variant="outline" className="ml-1 text-[10px]">
        {uniqueSpeakers.length}
      </Badge>
    </CardTitle>
  );

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          {onToggleCollapse ? (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-expanded={!collapsed}
              className="flex w-full items-center justify-between text-left"
            >
              {titleNode}
              {collapsed ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          ) : (
            titleNode
          )}
        </CardHeader>
        {!collapsed && (
          <CardContent className="space-y-1.5 pb-3">
            {canEdit && onGuessNames && (
              <div className="flex justify-end pb-1">
                <button
                  type="button"
                  onClick={onGuessNames}
                  disabled={guessingNames}
                  title="Match each voice against known people (local voiceprints — no AI call)"
                  className="flex items-center gap-1 rounded border border-violet-300 px-2 py-1 text-[11px] text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950 transition-colors"
                >
                  <Sparkles className={`h-3 w-3 ${guessingNames ? 'animate-pulse' : ''}`} />
                  {guessingNames ? 'Listening…' : 'Guess names'}
                </button>
              </div>
            )}
            {uniqueSpeakers.map((speaker) => {
              const mapping = speakerLabels.find((m) => m.originalSpeaker === speaker);
              const name = mapping?.customName?.trim() ?? '';
              const description = mapping?.description?.trim() ?? '';
              const displayName = name || `Unnamed · ${defaultSpeakerLabel(speaker)}`;
              return (
                <div key={speaker} className="rounded-md border bg-card px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="shrink-0">
                      {defaultSpeakerLabel(speaker)}
                    </Badge>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {(utteranceCounts[speaker] ?? 0)} line
                      {(utteranceCounts[speaker] ?? 0) === 1 ? '' : 's'}
                    </span>
                    <div
                      className={`min-w-0 flex-1 truncate text-sm ${
                        name ? '' : 'text-muted-foreground italic'
                      }`}
                      onDoubleClick={() => canEdit && setEditSpeaker(speaker)}
                      title={canEdit ? 'Double-click to edit' : ''}
                    >
                      {displayName}
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => setEditSpeaker(speaker)}
                        className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        title="Edit name & context (and preview this voice)"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                    )}
                  </div>
                  {description && (
                    <p
                      onDoubleClick={() => canEdit && setEditSpeaker(speaker)}
                      className="pt-1 text-xs text-muted-foreground whitespace-pre-wrap"
                      title={canEdit ? 'Double-click to edit' : ''}
                    >
                      {description}
                    </p>
                  )}
                  {/* Auto-detected identity — only while the speaker is unnamed. */}
                  {!name && suggestions?.[speaker] && (() => {
                    const s = suggestions[speaker]!;
                    const isVoice = s.source !== 'context';
                    return (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <span
                          className="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400"
                          title={!isVoice && s.evidence ? `Evidence: ${s.evidence}` : undefined}
                        >
                          <Sparkles className="h-3 w-3" />
                          {isVoice ? 'Sounds like' : 'Transcript suggests'}{' '}
                          <strong>{s.name}</strong>
                          {isVoice ? (
                            <span className="text-muted-foreground">
                              ({Math.round(s.confidence * 100)}% voice match)
                            </span>
                          ) : (
                            <span className="text-muted-foreground">(from context)</span>
                          )}
                        </span>
                        {canEdit && (
                          <>
                            <button
                              type="button"
                              onClick={() => onSave(speaker, { customName: s.name })}
                              className="rounded border border-violet-300 px-1.5 py-0.5 text-[11px] text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950 transition-colors"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => onRequestCreatePerson(speaker, s.name)}
                              title="Confirm and add this person to the people directory"
                              className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                            >
                              + Add person
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
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
