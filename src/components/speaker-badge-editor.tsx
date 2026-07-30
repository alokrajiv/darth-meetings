'use client';

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { UserPicker, type PickerPerson } from '@/components/user-picker';
import type { SpeakerLabel } from '@/lib/format';
import { defaultSpeakerLabel, speakerColorVar } from '@/lib/speaker-display';

interface SpeakerBadgeEditorProps {
  originalSpeaker: string;
  speakerLabels: SpeakerLabel[];
  /**
   * Save a partial update to the speaker. Description is left untouched
   * by this inline editor — for that, use the SpeakerSummaryPanel at the
   * top of the page.
   */
  onSave: (originalSpeaker: string, patch: { customName: string }) => void;
  /** Disable the pen + picker when the caller lacks edit access. */
  canEdit: boolean;
  /** Called when the picker commits a real Trames / custom person. */
  onPickPerson?: (person: PickerPerson) => void;
  /** Called when the picker commits custom text so the parent can open
   *  the AddPersonDialog. If not provided, custom text is just saved as
   *  the speaker's customName directly. */
  onRequestCreatePerson?: (originalSpeaker: string, name: string) => void;
}

/**
 * Inline speaker label with a pen. Click the pen → the label transforms in
 * place into a compact UserPicker. The picker lets you either search Trames
 * users by name/email or commit free text via the "Use '…'" affordance. Save
 * calls onSave with the new custom name; the parent does a global rename of
 * this speaker across the whole transcript.
 *
 * Description editing still happens in the top-of-page SpeakerSummaryPanel
 * where there's room for a textarea.
 */
export function SpeakerBadgeEditor({
  originalSpeaker,
  speakerLabels,
  onSave,
  canEdit,
  onPickPerson,
  onRequestCreatePerson,
}: SpeakerBadgeEditorProps) {
  const mapping = speakerLabels.find((m) => m.originalSpeaker === originalSpeaker);
  const currentDisplay = mapping?.customName || defaultSpeakerLabel(originalSpeaker);

  const [isEditing, setIsEditing] = useState(false);

  if (isEditing && canEdit) {
    return (
      <div
        className="flex items-center gap-1 rounded-md border bg-background px-2 py-1"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-[10px] text-muted-foreground">
          {defaultSpeakerLabel(originalSpeaker)} →
        </span>
        <div className="w-48">
          <UserPicker
            mode="freeform"
            compact
            initialValue={mapping?.customName ?? ''}
            placeholder="Name or email"
            onSelect={(sel) => {
              setIsEditing(false);
              if (sel.type === 'person') {
                onSave(originalSpeaker, { customName: sel.person.name });
                onPickPerson?.(sel.person);
              }
            }}
            onCustomSubmit={(text) => {
              setIsEditing(false);
              if (onRequestCreatePerson) {
                onRequestCreatePerson(originalSpeaker, text);
              } else {
                onSave(originalSpeaker, { customName: text });
              }
            }}
            onCancel={() => setIsEditing(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5"
      onDoubleClick={(e) => {
        if (!canEdit) return;
        e.stopPropagation();
        setIsEditing(true);
      }}
      title={canEdit ? 'Double-click to edit speaker' : ''}
    >
      <span
        className="truncate text-xs font-semibold"
        style={{ color: speakerColorVar(originalSpeaker) }}
      >
        {currentDisplay}
      </span>
      {mapping?.customName && mapping.customName !== defaultSpeakerLabel(originalSpeaker) && (
        // Raw diarization label as a qualifier — but Meet/text imports arrive
        // with real names as the raw label, where "Jane (Jane)" is noise.
        <span className="shrink-0 text-[10px] text-muted-foreground">
          ({defaultSpeakerLabel(originalSpeaker)})
        </span>
      )}
      {canEdit && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsEditing(true);
          }}
          className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:text-foreground"
          title="Edit speaker name"
          aria-label="Edit speaker"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
