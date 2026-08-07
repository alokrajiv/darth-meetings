'use client';

import { useEffect, useRef, useState } from 'react';
import { formatTime, type SpeakerLabel } from '@/lib/format';
import { SpeakerBadgeEditor } from '@/components/speaker-badge-editor';
import type { PickerPerson } from '@/components/user-picker';
import { Pencil } from 'lucide-react';

interface Utterance {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

/** A find-and-replace match within this utterance's display text. */
export interface UtteranceHighlight {
  start: number;
  end: number;
  /** Whether this is the user's currently-focused match (gets a stronger highlight). */
  isCurrent: boolean;
}

interface EditableUtteranceProps {
  index: number;
  utterance: Utterance;
  /** Composed display text (raw + any text override). */
  displayText: string;
  /** Whether the displayed text differs from raw — used to show an "edited" dot. */
  isTextEdited: boolean;
  /** Whether this utterance is the one currently playing in the audio player. */
  isActive: boolean;
  /** All speaker labels for this transcript (used to display the right name). */
  speakerLabels: SpeakerLabel[];
  /** Optional highlights to overlay on the text in display mode (find-and-replace). */
  highlights?: UtteranceHighlight[];
  /** Click an utterance → seek the player to its start. */
  onSeek: (index: number) => void;
  /** Click-to-edit on text saved this new value. */
  onSaveText: (index: number, newText: string) => void;
  /** Pen on speaker label saved a partial speaker patch (name only — description goes through the summary panel). */
  onSaveSpeaker: (originalSpeaker: string, patch: { customName: string }) => void;
  /** Controls both text and speaker editing affordances. */
  canEdit: boolean;
  /** Speaker-turn grouping: render the speaker header line only when this is
   *  the first utterance of a turn (or the first after a segment heading). */
  showSpeaker: boolean;
  /** Forwarded to SpeakerBadgeEditor so the page can show the add-to-access prompt. */
  onPickPerson?: (person: PickerPerson) => void;
  /** Forwarded to SpeakerBadgeEditor so the page can open AddPersonDialog. */
  onRequestCreatePerson?: (originalSpeaker: string, name: string) => void;
}

/**
 * One utterance in the transcript view, laid out as a document row:
 * timestamp gutter on the left, speaker header (per turn) + text on the
 * right. Double-click the text to edit it inline. Click the pen on the
 * speaker label to rename that speaker globally.
 *
 * Editing the text writes to `transcript_edits` (per-user, per-utterance);
 * editing the speaker writes to `speaker_mappings` (per-user, global to this
 * transcript). The raw AAI content is never mutated.
 */
export function EditableUtterance({
  index,
  utterance,
  displayText,
  isTextEdited,
  isActive,
  speakerLabels,
  highlights,
  onSeek,
  onSaveText,
  onSaveSpeaker,
  canEdit,
  showSpeaker,
  onPickPerson,
  onRequestCreatePerson,
}: EditableUtteranceProps) {
  const [isEditingText, setIsEditingText] = useState(false);
  const [draftText, setDraftText] = useState(displayText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraftText(displayText);
  }, [displayText]);

  useEffect(() => {
    if (isEditingText && textareaRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autoResize(ta);
    }
  }, [isEditingText]);

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function commitText() {
    setIsEditingText(false);
    if (draftText !== displayText) {
      onSaveText(index, draftText);
    }
  }

  function cancelText() {
    setIsEditingText(false);
    setDraftText(displayText);
  }

  /**
   * Render display text with highlight ranges interleaved as <mark> tags.
   * Used by find-and-replace; the "current" match gets a stronger style.
   */
  function renderHighlightedText(text: string, ranges: UtteranceHighlight[]): React.ReactNode {
    if (!ranges || ranges.length === 0) return text;
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const out: React.ReactNode[] = [];
    let cursor = 0;
    sorted.forEach((r, i) => {
      if (r.start > cursor) out.push(text.substring(cursor, r.start));
      out.push(
        <mark
          key={`hl-${i}`}
          data-current={r.isCurrent || undefined}
          className={
            r.isCurrent
              ? 'rounded bg-amber-300 text-foreground dark:bg-amber-400/40'
              : 'rounded bg-yellow-200 text-foreground dark:bg-yellow-300/25'
          }
        >
          {text.substring(r.start, r.end)}
        </mark>
      );
      cursor = r.end;
    });
    if (cursor < text.length) out.push(text.substring(cursor));
    return out;
  }

  // The whole row is the click target so the hover-highlighted area is
  // also the clickable seek surface. Action elements (timestamp button,
  // speaker label, pencil icons, edit textarea) stop propagation so they
  // keep their own behaviors.
  const handleRowClick = (e: React.MouseEvent) => {
    if (isEditingText) return;
    // Don't hijack a real text-selection drag or keyboard-modified click.
    if (e.detail === 0) return;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (sel && !sel.isCollapsed) return;
    onSeek(index);
  };

  const handleRowDoubleClick = (e: React.MouseEvent) => {
    if (!canEdit || isEditingText) return;
    e.preventDefault();
    setIsEditingText(true);
  };

  const editedDot = (
    <span
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50"
      title="Edited"
      aria-label="Edited"
    />
  );

  return (
    <div
      data-utterance-index={index}
      onClick={handleRowClick}
      onDoubleClick={handleRowDoubleClick}
      className={`group relative grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 rounded-md py-1 transition-colors ${
        isEditingText ? '' : 'cursor-pointer'
      } ${
        isActive
          ? 'bg-accent/50 before:absolute before:left-[-12px] before:top-1 before:bottom-1 before:w-0.5 before:rounded-full before:bg-primary'
          : 'hover:bg-muted/50'
      }`}
      title={
        isEditingText
          ? ''
          : canEdit
            ? 'Click to seek · double-click or pencil icon to edit'
            : 'Click to seek'
      }
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSeek(index);
        }}
        className={`pt-1 text-right font-mono text-[11px] tabular-nums ${
          isActive
            ? 'font-medium text-primary'
            : 'text-muted-foreground/70 hover:text-primary'
        }`}
        title="Seek audio to this moment"
      >
        {formatTime(utterance.start)}
      </button>
      <div className="min-w-0">
        {showSpeaker && (
          <div
            className="mb-0.5 flex items-center gap-2"
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <SpeakerBadgeEditor
              originalSpeaker={utterance.speaker}
              speakerLabels={speakerLabels}
              onSave={onSaveSpeaker}
              canEdit={canEdit}
              onPickPerson={onPickPerson}
              onRequestCreatePerson={onRequestCreatePerson}
            />
            {isTextEdited && editedDot}
          </div>
        )}
        {isEditingText && canEdit ? (
          <textarea
            ref={textareaRef}
            value={draftText}
            onChange={(e) => {
              setDraftText(e.target.value);
              autoResize(e.target);
            }}
            onBlur={commitText}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitText();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelText();
              }
            }}
            rows={1}
            className="w-full resize-none rounded-md border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        ) : (
          <p className="max-w-[75ch] text-sm leading-6">
            {highlights && highlights.length > 0
              ? renderHighlightedText(displayText, highlights)
              : displayText}
            {isTextEdited && !showSpeaker && (
              <span className="ml-1.5 inline-flex align-middle">{editedDot}</span>
            )}
          </p>
        )}
      </div>
      {canEdit && !isEditingText && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsEditingText(true);
          }}
          className="absolute right-1 top-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
          title="Edit text"
          aria-label="Edit utterance text"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
