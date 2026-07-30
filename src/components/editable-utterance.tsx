'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
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
  /** Whether the displayed text differs from raw — used to show an "edited" badge. */
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
  /** Pen on speaker badge saved a partial speaker patch (name only — description goes through the summary panel). */
  onSaveSpeaker: (originalSpeaker: string, patch: { customName: string }) => void;
  /** Controls both text and speaker editing affordances. */
  canEdit: boolean;
  /** Forwarded to SpeakerBadgeEditor so the page can show the add-to-access prompt. */
  onPickPerson?: (person: PickerPerson) => void;
  /** Forwarded to SpeakerBadgeEditor so the page can open AddPersonDialog. */
  onRequestCreatePerson?: (originalSpeaker: string, name: string) => void;
}

/**
 * One utterance in the transcript view. Click the text to edit it inline.
 * Click the pen on the speaker badge to rename that speaker globally.
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
              ? 'rounded bg-amber-300 text-foreground'
              : 'rounded bg-yellow-200 text-foreground'
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
  // speaker badge, pencil icons, edit textarea) stop propagation so they
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

  return (
    <div
      data-utterance-index={index}
      onClick={handleRowClick}
      onDoubleClick={handleRowDoubleClick}
      className={`group rounded-md border-l-4 pl-4 py-2 transition-colors ${
        isEditingText ? '' : 'cursor-pointer'
      } ${
        isActive
          ? 'border-blue-500 bg-blue-50'
          : 'border-blue-200 hover:bg-muted/40'
      }`}
      title={
        isEditingText
          ? ''
          : canEdit
            ? 'Click to seek · double-click or pencil icon to edit'
            : 'Click to seek'
      }
    >
      <div
        className="flex items-center gap-2 mb-1"
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
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSeek(index);
          }}
          className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          title="Seek audio to this moment"
        >
          {formatTime(utterance.start)}
        </button>
        {isTextEdited && (
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
            edited
          </Badge>
        )}
        {canEdit && !isEditingText && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsEditingText(true);
            }}
            className="ml-auto rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
            title="Edit text"
            aria-label="Edit utterance text"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
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
        <p className="text-sm rounded-md px-1 -mx-1">
          {highlights && highlights.length > 0
            ? renderHighlightedText(displayText, highlights)
            : displayText}
        </p>
      )}
    </div>
  );
}
