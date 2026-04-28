'use client';

import { useMemo, useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { UserPicker, type PickerPerson } from '@/components/user-picker';
import { ChevronDown, ChevronUp, Pencil, Users } from 'lucide-react';
import type { SpeakerLabel } from '@/lib/format';
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
  /** Disables all editing when false. */
  canEdit: boolean;
  /** Called when the picker commits a real Trames / custom person. */
  onPickPerson: (person: PickerPerson) => void;
  /** Called when the picker commits a custom *name* (no email) and the
   *  page should open the AddPersonDialog to promote it. */
  onRequestCreatePerson: (originalSpeaker: string, name: string) => void;
}

/**
 * Top-of-page Speakers card. Single-line rows by default — the name picker
 * occupies the main column, with a chevron on the right to reveal an
 * optional description textarea. Descriptions that already have content are
 * expanded on load so you don't lose track of them.
 */
export function SpeakerSummaryPanel({
  utterances,
  speakerLabels,
  onSave,
  canEdit,
  onPickPerson,
  onRequestCreatePerson,
}: SpeakerSummaryPanelProps) {
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" />
          Speakers
          <Badge variant="outline" className="ml-1 text-[10px]">
            {uniqueSpeakers.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 pb-3">
        {uniqueSpeakers.map((speaker) => {
          const mapping = speakerLabels.find((m) => m.originalSpeaker === speaker);
          return (
            <SpeakerRow
              key={speaker}
              originalSpeaker={speaker}
              count={utteranceCounts[speaker] ?? 0}
              initialName={mapping?.customName ?? ''}
              initialDescription={mapping?.description ?? ''}
              onSave={onSave}
              onPickPerson={onPickPerson}
              onRequestCreatePerson={onRequestCreatePerson}
              canEdit={canEdit}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}

interface SpeakerRowProps {
  originalSpeaker: string;
  count: number;
  initialName: string;
  initialDescription: string;
  onSave: (
    originalSpeaker: string,
    patch: { customName?: string; description?: string }
  ) => void;
  onPickPerson: (person: PickerPerson) => void;
  onRequestCreatePerson: (originalSpeaker: string, name: string) => void;
  canEdit: boolean;
}

function SpeakerRow({
  originalSpeaker,
  count,
  initialName,
  initialDescription,
  onSave,
  onPickPerson,
  onRequestCreatePerson,
  canEdit,
}: SpeakerRowProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [editingName, setEditingName] = useState(false);
  const [expanded, setExpanded] = useState(initialDescription.trim().length > 0);

  useEffect(() => {
    setName(initialName);
  }, [initialName]);
  useEffect(() => {
    setDescription(initialDescription);
    if (initialDescription.trim().length > 0) setExpanded(true);
  }, [initialDescription]);

  const commitDescription = () => {
    if (description === initialDescription) return;
    onSave(originalSpeaker, { description: description.trim() });
  };

  const commitName = (newName: string) => {
    const trimmed = newName.trim();
    setName(trimmed);
    setEditingName(false);
    if (trimmed === initialName) return;
    onSave(originalSpeaker, { customName: trimmed });
  };

  const displayName = name.trim() || `Unnamed · ${defaultSpeakerLabel(originalSpeaker)}`;

  return (
    <div className="rounded-md border bg-card px-2 py-1.5">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="shrink-0">
          {defaultSpeakerLabel(originalSpeaker)}
        </Badge>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count} line{count === 1 ? '' : 's'}
        </span>
        <div className="min-w-0 flex-1">
          {editingName && canEdit ? (
            <UserPicker
              mode="freeform"
              compact
              initialValue={name}
              placeholder="Search by name or email…"
              onSelect={(sel) => {
                if (sel.type === 'person') {
                  commitName(sel.person.name);
                  onPickPerson(sel.person);
                }
              }}
              onCustomSubmit={(text) => {
                setEditingName(false);
                onRequestCreatePerson(originalSpeaker, text);
              }}
              onCancel={() => setEditingName(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => canEdit && setEditingName(true)}
              className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${
                canEdit ? 'hover:bg-muted/50' : 'cursor-default'
              } ${name.trim() ? '' : 'text-muted-foreground italic'}`}
              title={canEdit ? 'Click to edit' : 'Read-only'}
            >
              <span className="truncate">{displayName}</span>
              {canEdit && (
                <Pencil className="h-3 w-3 ml-auto text-muted-foreground/60" />
              )}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          title={expanded ? 'Hide context' : 'Add context'}
        >
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <>
              <span>Context</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </>
          )}
        </button>
      </div>
      {expanded && (
        <div className="pt-1.5">
          <Textarea
            value={description}
            placeholder="Role, voice, background, anything that helps you tell them apart…"
            rows={2}
            readOnly={!canEdit}
            className="text-xs"
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
          />
        </div>
      )}
    </div>
  );
}
