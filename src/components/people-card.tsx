'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { PersonChip } from '@/components/person-chip';
import { type PickerPerson } from '@/components/user-picker';
import { SpeakerPreviewDialog } from '@/components/speaker-preview-dialog';
import type { ServedPlayback } from '@/lib/clip-window';
import { ChevronDown, ChevronUp, Fingerprint, MicOff, Pencil, Sparkles, Users } from 'lucide-react';
import type { GmeetAttendee, SpeakerLabel, SpeakerSuggestionMap } from '@/lib/format';
import { personDisplay } from '@/lib/person-display';
import { speakerColorVar } from '@/lib/speaker-display';
import { countVoices, speakerNameStates, voiceMatchCaveat, voiceMatchLabel, type SpeakerNameState } from '@/lib/speaker-name-state';

interface Utterance {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

interface PeopleCardProps {
  utterances: Utterance[];
  speakerLabels: SpeakerLabel[];
  /** Voiceprint / Meet-align / speaker-ID guesses keyed by original speaker. */
  suggestions?: SpeakerSuggestionMap;
  onSave: (originalSpeaker: string, patch: { customName?: string; description?: string }) => void;
  /** Disables editing when false (pencils hidden, no Confirm). */
  canEdit: boolean;
  onPickPerson: (person: PickerPerson) => void;
  onRequestCreatePerson: (originalSpeaker: string, name: string) => void;
  /** /api/transcripts/[id]/audio — voice samples in the dialog. Null = no audio. */
  audioSrc: string | null;
  /** How `audioSrc` (the server's cut) maps onto the meeting's timeline —
   * the main player's `ServedPlayback`. Absent = 1:1. */
  audioServed?: ServedPlayback | null;
  hasVideo?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Run voiceprint matching on demand ("Guess names" button). */
  onGuessNames?: () => void;
  guessingNames?: boolean;
  /** The speaker-ID AI pass is still running — guesses may still land. */
  identifying?: boolean;
  /** Calendar invitees, when the row is linked to an event. */
  attendees?: GmeetAttendee[] | null;
  organizerEmail?: string | null;
  /** The signed-in user's e-mail — their own chip reads "You". */
  selfEmail?: string | null;
  /**
   * "Speaker A · phone" — which RECORDING each voice was heard on (Phase 3b,
   * spec §"Reader and writer changes"). A meeting over several recordings
   * diarizes each one separately, so "Speaker A" on the phone and "Speaker A"
   * on the video are different people until somebody says otherwise; the tag
   * is what makes that visible. Null (and invisible) for every meeting with
   * one recording.
   */
  sourceTagOf?: ((speaker: string) => string | null) | null;
}

const INVITED_CAP = 10;

/**
 * "People" — who spoke (by voice, state-aware) and who was invited
 * (docs/transcript-page-redesign.md §3.5, §4). Replaces the Speakers panel
 * and the About card's INVITED / SPEAKERS rows. Every row reads
 * `speakerNameState()`, the same merge the edit dialog seeds from — so a
 * guess shown here is the guess the pencil opens with.
 */
export function PeopleCard({
  utterances,
  speakerLabels,
  suggestions,
  onSave,
  canEdit,
  onPickPerson,
  onRequestCreatePerson,
  audioSrc,
  audioServed = null,
  hasVideo,
  collapsed,
  onToggleCollapse,
  onGuessNames,
  guessingNames,
  identifying,
  attendees,
  organizerEmail,
  selfEmail,
  sourceTagOf,
}: PeopleCardProps) {
  const [editSpeaker, setEditSpeaker] = useState<string | null>(null);
  const [invitedExpanded, setInvitedExpanded] = useState(false);
  const uniqueSpeakers = useMemo(
    () => Array.from(new Set(utterances.map((u) => u.speaker))).sort(),
    [utterances]
  );
  const states = useMemo(
    () => speakerNameStates(uniqueSpeakers, speakerLabels, suggestions),
    [uniqueSpeakers, speakerLabels, suggestions]
  );
  const voices = countVoices(states);

  // Suggested names that already exist in the people directory. Voice
  // matches come from enrolled voiceprints (known people by definition);
  // context guesses are checked against /api/users/search so "+ Person"
  // only shows for genuinely new names.
  const [knownNames, setKnownNames] = useState<Set<string>>(new Set());
  const contextNamesKey = useMemo(
    () =>
      [
        ...new Set(
          states
            .filter((s) => s.status === 'guess' && s.suggestion?.source === 'context')
            .map((s) => s.name)
        ),
      ]
        .sort()
        .join('\n'),
    [states]
  );
  useEffect(() => {
    const names = contextNamesKey ? contextNamesKey.split('\n') : [];
    if (names.length === 0) return;
    let cancelled = false;
    void (async () => {
      const found = new Set<string>();
      await Promise.all(
        names.map(async (name) => {
          try {
            const res = await fetch(`/api/users/search?q=${encodeURIComponent(name)}&limit=5`);
            if (!res.ok) return;
            const { people } = (await res.json()) as { people: Array<{ name: string }> };
            if (people.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) {
              found.add(name.toLowerCase());
            }
          } catch {
            // directory check is cosmetic — ignore failures
          }
        })
      );
      if (!cancelled) setKnownNames(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [contextNamesKey]);

  const utteranceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const u of utterances) counts[u.speaker] = (counts[u.speaker] ?? 0) + 1;
    return counts;
  }, [utterances]);

  // --- Invited ------------------------------------------------------------
  const invited = useMemo(() => {
    const out: GmeetAttendee[] = [];
    const seen = new Set<string>();
    for (const a of attendees ?? []) {
      const key = (a.email || a.name || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    const org = (organizerEmail ?? '').toLowerCase();
    if (org) {
      const i = out.findIndex((a) => a.email.toLowerCase() === org);
      if (i > 0) out.unshift(...out.splice(i, 1));
      else if (i < 0) out.unshift({ email: organizerEmail! });
    }
    return out;
  }, [attendees, organizerEmail]);
  const spokeNames = useMemo(
    () =>
      new Set(
        states
          .filter((s) => s.status === 'confirmed')
          .map((s) => s.name.toLowerCase())
      ),
    [states]
  );
  const spoke = (a: GmeetAttendee) => {
    const full = personDisplay(a.email, a.name).full.toLowerCase();
    return spokeNames.has(full) || spokeNames.has((a.name ?? '').trim().toLowerCase());
  };
  const shownInvited = invitedExpanded ? invited : invited.slice(0, INVITED_CAP);
  const hiddenInvited = invited.length - shownInvited.length;

  const titleInner = (
    <>
      <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-[13px] font-semibold">People</span>
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground" data-people-count>
        {voices} {voices === 1 ? 'voice' : 'voices'}
        {invited.length > 0 ? ` · ${invited.length} invited` : ''}
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
            <div className="mb-1.5 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Voices
              <span className="font-normal normal-case tracking-normal">
                {voices} · who spoke, by voice{identifying ? ' · the AI is still guessing names' : ''}
              </span>
            </div>
            <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2" data-speakers>
              {states.map((s) => (
                <VoiceRow
                  key={s.speaker}
                  state={s}
                  count={utteranceCounts[s.speaker] ?? 0}
                  sourceTag={sourceTagOf?.(s.speaker) ?? null}
                  canEdit={canEdit}
                  offerCreatePerson={
                    s.status === 'guess' &&
                    s.suggestion?.source === 'context' &&
                    !knownNames.has(s.name.toLowerCase())
                  }
                  onEdit={() => setEditSpeaker(s.speaker)}
                  onConfirm={() => onSave(s.speaker, { customName: s.name })}
                  onCreatePerson={() => onRequestCreatePerson(s.speaker, s.name)}
                />
              ))}
            </div>

            {invited.length > 0 && (
              <>
                <div className="mt-4 mb-1.5 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Invited
                  <span className="font-normal normal-case tracking-normal">
                    {invited.length} · from the calendar invite
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5" data-invited>
                  {shownInvited.map((a) => {
                    const isOrganizer = !!organizerEmail && a.email.toLowerCase() === organizerEmail.toLowerCase();
                    const isSelf = !!selfEmail && a.email.toLowerCase() === selfEmail.toLowerCase();
                    return (
                      <PersonChip
                        key={a.email || a.name}
                        email={a.email}
                        name={a.name}
                        self={isSelf}
                        trailing={
                          <>
                            {isOrganizer && (
                              <span className="rounded border px-1 text-[10px] text-muted-foreground">organizer</span>
                            )}
                            {spoke(a) && (
                              <span
                                className="h-1.5 w-1.5 rounded-full bg-status-ok"
                                title="spoke in this meeting"
                                aria-label="spoke"
                              />
                            )}
                          </>
                        }
                      />
                    );
                  })}
                  {hiddenInvited > 0 && (
                    <button
                      type="button"
                      className="text-xs font-medium text-primary hover:underline"
                      onClick={() => setInvitedExpanded(true)}
                    >
                      +{hiddenInvited} more
                    </button>
                  )}
                  {invitedExpanded && invited.length > INVITED_CAP && (
                    <button
                      type="button"
                      className="text-xs font-medium text-muted-foreground hover:underline"
                      onClick={() => setInvitedExpanded(false)}
                    >
                      show fewer
                    </button>
                  )}
                </div>
              </>
            )}
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
          suggestions={suggestions}
          audioSrc={audioSrc}
          served={audioServed}
          hasVideo={hasVideo}
          canEdit={canEdit}
          onSave={onSave}
          onPickPerson={onPickPerson}
          onRequestCreatePerson={onRequestCreatePerson}
          sourceTagOf={sourceTagOf}
        />
      )}
    </>
  );
}

function VoiceRow({
  state: s,
  count,
  sourceTag,
  canEdit,
  offerCreatePerson,
  onEdit,
  onConfirm,
  onCreatePerson,
}: {
  state: SpeakerNameState;
  count: number;
  /** Which recording this voice was heard on — Phase 3b, null otherwise. */
  sourceTag?: string | null;
  canEdit: boolean;
  offerCreatePerson: boolean;
  onEdit: () => void;
  onConfirm: () => void;
  onCreatePerson: () => void;
}) {
  const evidenceTitle =
    s.status === 'guess'
      ? s.suggestion?.source === 'voice'
        ? `${voiceMatchLabel(s.suggestion)} — ${voiceMatchCaveat(s.suggestion)}` +
          (s.suggestion.evidence ? `; the transcript agrees — ${s.suggestion.evidence}` : '')
        : s.suggestion?.evidence
          ? `Evidence: ${s.suggestion.evidence}`
          : s.suggestion
            ? `${voiceMatchLabel(s.suggestion)} — ${voiceMatchCaveat(s.suggestion)}`
            : undefined
      : s.status === 'group'
        ? `Labelled “${s.name}” — a shared mic, not a person`
        : s.description || (canEdit ? 'Double-click to edit' : undefined);
  return (
    <div
      className="group rounded-md px-2 py-1 hover:bg-muted/60"
      onDoubleClick={() => canEdit && onEdit()}
      title={evidenceTitle}
      data-speaker={s.speaker}
      data-speaker-state={s.status}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: speakerColorVar(s.speaker) }} />
        {s.status === 'group' ? (
          <span className="inline-flex min-w-0 items-center gap-1 truncate text-sm text-muted-foreground">
            <MicOff className="h-3 w-3 shrink-0" />
            {s.display}
          </span>
        ) : (
          <span
            className={`truncate text-sm ${
              s.status === 'confirmed'
                ? 'font-medium'
                : s.status === 'guess'
                  ? 'font-medium text-primary'
                  : 'italic text-muted-foreground'
            }`}
          >
            {s.display}
            {s.status === 'guess' ? '?' : ''}
          </span>
        )}
        {sourceTag && (
          <span
            className="shrink-0 rounded border px-1 py-px text-[10px] leading-tight text-muted-foreground"
            title={`Heard on ${sourceTag} — each recording is diarized on its own, so this voice is named separately`}
            data-voice-source
          >
            {sourceTag}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          · {count} {count === 1 ? 'line' : 'lines'}
        </span>
        {s.status === 'guess' && s.suggestion && (
          <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            {s.suggestion.source === 'voice' ? (
              <>
                <Fingerprint className="h-3 w-3 shrink-0 text-primary" />
                {voiceMatchLabel(s.suggestion).replace(/ match$/, '')}
                {s.suggestion.offRoster ? ' · not invited' : ''}
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3 shrink-0 text-primary" />
                from the transcript
              </>
            )}
          </span>
        )}
        {canEdit && s.status === 'guess' && (
          <>
            <button
              type="button"
              onClick={onConfirm}
              className="shrink-0 rounded border border-primary/30 px-1.5 py-0.5 text-[11px] text-primary transition-colors hover:bg-accent"
              data-speaker-confirm
            >
              Confirm
            </button>
            {offerCreatePerson && (
              <button
                type="button"
                onClick={onCreatePerson}
                title="Confirm and add this person to the people directory"
                className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                + Person
              </button>
            )}
          </>
        )}
        {canEdit && s.status === 'unknown' && (
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 rounded border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Name…
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="ml-auto shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
            title="Edit name & context (and preview this voice)"
            aria-label={`Edit speaker ${s.speaker}`}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
