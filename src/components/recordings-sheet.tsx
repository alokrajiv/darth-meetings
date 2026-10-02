'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Loader2,
  Plus,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  ALIGN_WIDE_WINDOW_MS,
  alignAdvice,
  alignVerdict,
  formatTimestamp,
  parseTimestampMs,
  type AlignResponse,
  type ClipCandidate,
  type ClipCandidatesResponse,
  type ClipEntry,
  type ClipMutationResponse,
} from '@/lib/clips';
import {
  NUDGE_STEPS_MS,
  POLICY_CHOICES,
  alignTimeline,
  alignVerdictLine,
  candidateFacts,
  clipRows,
  groupCandidates,
  nudgeLabel,
  nudgeOffset,
  slotsLeftText,
  type AlignVerdictLine,
} from '@/lib/combine-ui';
import type { ClipTextPolicy } from '@/lib/recording-clips';

/**
 * "Recordings" — several recordings, one meeting (Phase 3b,
 * docs/recordings-phase3b-combine-spec.md §UI).
 *
 * Two steps in one sheet. The LIST is what the meeting holds: each clip's
 * source, whose bytes they are, where it sits on the meeting's timeline and
 * what its text does — all editable in place (`PATCH …/clips/:ord`), with the
 * last clip's remove greyed and the route's own sentence on it. **Add a
 * recording…** opens the second step: the caller-scoped candidates, then
 * **Line them up**, where the offset is typed, nudged, or guessed by
 * `POST /api/recordings/:id/align` — and a guess is only ever SHOWN. Nothing
 * reaches the meeting until Add is pressed.
 *
 * Everything the sheet says is `lib/combine-ui.ts` (pure, unit-tested) and
 * every refusal it prints is the server's own words.
 */

interface RecordingsSheetProps {
  open: boolean;
  onClose: () => void;
  transcriptId: string;
  entries: ClipEntry[];
  /** `MW_COMBINE` — false hides "Add a recording…" and the align step, and
   * leaves the list as a read-out of what the meeting holds. */
  combineEnabled: boolean;
  canEdit: boolean;
  canAddRecording: boolean;
  addBlockedReason: string | null;
  /** A clip changed: the meeting's text was re-materialised, so the page
   * reloads the row as well as the clip list. */
  onChanged: () => void;
}

type Step = 'list' | 'pick' | 'align';

export function RecordingsSheet({
  open,
  onClose,
  transcriptId,
  entries,
  combineEnabled,
  canEdit,
  canAddRecording,
  addBlockedReason,
  onChanged,
}: RecordingsSheetProps) {
  const [step, setStep] = useState<Step>('list');
  const [error, setError] = useState<string | null>(null);
  const [busyOrd, setBusyOrd] = useState<number | null>(null);

  // --- the list --------------------------------------------------------
  // With MW_COMBINE off the list is still shown — it is a description of the
  // meeting — but every mutation would come back `disabled`, so nothing is
  // offered that the route would refuse.
  const canMutate = canEdit && combineEnabled;
  const rows = useMemo(() => clipRows(entries), [entries]);
  /** The offset field, per clip, while it is being typed. */
  const [offsetDraft, setOffsetDraft] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open) {
      setStep('list');
      setError(null);
      setOffsetDraft({});
      setCandidates(null);
      setPicked(null);
      setAlignLine(null);
    }
  }, [open]);

  const mutate = useCallback(
    async (ord: number, init: RequestInit) => {
      setBusyOrd(ord);
      setError(null);
      try {
        const res = await fetch(`/api/transcripts/${transcriptId}/clips/${ord}`, init);
        const payload = (await res.json().catch(() => ({}))) as ClipMutationResponse;
        if (!res.ok || !('ok' in payload)) {
          throw new Error(
            ('error' in payload && payload.error) || `That did not go through (${res.status})`
          );
        }
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not go through');
      } finally {
        setBusyOrd(null);
      }
    },
    [transcriptId, onChanged]
  );

  const patchOffset = useCallback(
    (ord: number, text: string) => {
      const ms = parseTimestampMs(text);
      if (ms === null) {
        setError('That offset is not a time — use 1:50 or 1:50:00.');
        return;
      }
      setOffsetDraft((d) => {
        const next = { ...d };
        delete next[ord];
        return next;
      });
      void mutate(ord, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMs: ms }),
      });
    },
    [mutate]
  );

  const patchPolicy = useCallback(
    (ord: number, textPolicy: ClipTextPolicy) => {
      void mutate(ord, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ textPolicy }),
      });
    },
    [mutate]
  );

  const removeClip = useCallback(
    (ord: number) => void mutate(ord, { method: 'DELETE' }),
    [mutate]
  );

  // --- the candidates --------------------------------------------------
  const [candidates, setCandidates] = useState<ClipCandidatesResponse | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [picked, setPicked] = useState<ClipCandidate | null>(null);

  const openPicker = useCallback(() => {
    setStep('pick');
    setError(null);
    setLoadingCandidates(true);
    void (async () => {
      try {
        const res = await fetch(`/api/transcripts/${transcriptId}/clips/candidates`);
        if (!res.ok) throw new Error(`Could not list your recordings (${res.status})`);
        setCandidates((await res.json()) as ClipCandidatesResponse);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not list your recordings');
      } finally {
        setLoadingCandidates(false);
      }
    })();
  }, [transcriptId]);

  // --- "Line them up" --------------------------------------------------
  const [offsetText, setOffsetText] = useState('0:00');
  const [policy, setPolicy] = useState<ClipTextPolicy>('gap_fill');
  const [guessing, setGuessing] = useState(false);
  const [alignLine, setAlignLine] = useState<AlignVerdictLine | null>(null);
  const [adding, setAdding] = useState(false);

  const offsetMs = parseTimestampMs(offsetText) ?? 0;
  const offsetValid = parseTimestampMs(offsetText) !== null;

  const choose = useCallback((c: ClipCandidate) => {
    setPicked(c);
    setAlignLine(null);
    setError(null);
    // The nominal from the two clocks, when both are known — the spec's seed
    // for the search, never an answer (§"The offset — never guessed silently").
    setOffsetText(formatTimestamp(Math.max(0, c.nominalOffsetMs ?? 0)));
    // A recording still transcribing can only join as "Audio only".
    setPolicy(c.transcribed ? 'gap_fill' : 'exclude');
    setStep('align');
  }, []);

  /** The recording the offset is measured against: the meeting's primary. */
  const primary = useMemo(
    () => entries.find((e) => e.primary) ?? entries[0] ?? null,
    [entries]
  );

  const guess = useCallback(() => {
    if (!picked || !primary) return;
    setGuessing(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/recordings/${picked.recordingId}/align`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            against: primary.recordingId,
            ...(picked.nominalOffsetMs != null
              ? { nominalOffsetMs: picked.nominalOffsetMs }
              : { searchWindowMs: ALIGN_WIDE_WINDOW_MS }),
          }),
        });
        const payload = (await res.json().catch(() => ({}))) as AlignResponse;
        if (!res.ok || !('ok' in payload)) {
          throw new Error(
            ('error' in payload && payload.error) || `Could not line them up (${res.status})`
          );
        }
        const line = alignVerdictLine({
          verdict: alignVerdict(payload.confidence),
          offsetMs: payload.offsetMs,
          confidence: payload.confidence,
          driftPpm: payload.driftPpm,
          overlapMs: payload.overlapMs,
          advice: payload.advice ?? alignAdvice(payload.confidence),
        });
        setAlignLine(line);
        // Under the floor NOTHING is applied — the number stays whatever the
        // person set by ear.
        if (line.applies) setOffsetText(formatTimestamp(Math.max(0, payload.offsetMs)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not line them up');
      } finally {
        setGuessing(false);
      }
    })();
  }, [picked, primary]);

  const add = useCallback(() => {
    if (!picked || !offsetValid) return;
    setAdding(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/transcripts/${transcriptId}/clips`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recordingId: picked.recordingId,
            offsetMs,
            textPolicy: policy,
          }),
        });
        const payload = (await res.json().catch(() => ({}))) as ClipMutationResponse;
        if (!res.ok || !('ok' in payload)) {
          throw new Error(
            ('error' in payload && payload.error) || `Could not add it (${res.status})`
          );
        }
        onChanged();
        setPicked(null);
        setAlignLine(null);
        setStep('list');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not add it');
      } finally {
        setAdding(false);
      }
    })();
  }, [picked, offsetValid, offsetMs, policy, transcriptId, onChanged]);

  const timeline = useMemo(
    () =>
      picked
        ? alignTimeline({
            entries,
            candidate: { label: picked.sourceLabel, durationMs: picked.durationMs },
            offsetMs,
          })
        : null,
    [picked, entries, offsetMs]
  );

  const groups = useMemo(
    () => groupCandidates(candidates?.candidates ?? []),
    [candidates]
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
        data-recordings-sheet
        data-step={step}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step !== 'list' && (
              <button
                type="button"
                onClick={() => {
                  setStep(step === 'align' ? 'pick' : 'list');
                  setError(null);
                }}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {step === 'list'
              ? 'Recordings'
              : step === 'pick'
                ? 'Add a recording'
                : 'Line them up'}
          </DialogTitle>
          <DialogDescription>
            {step === 'list'
              ? 'Every recording this meeting plays and reads from. Nothing here is cut or re-transcribed — each one keeps its own file and its own transcript.'
              : step === 'pick'
                ? 'Your own recordings, and the recordings of meetings you can edit. Adding one gives its audio to everybody who can read this meeting.'
                : 'Where does this recording start, measured from the beginning of this meeting? Nothing is applied until you press Add.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p
            className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
            data-sheet-error
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {/* ---------------------------------------------------------- list */}
        {step === 'list' && (
          <div className="space-y-2" data-clip-list>
            {rows.map((row) => {
              const busy = busyOrd === row.ord;
              const draft = offsetDraft[row.ord];
              return (
                <div
                  key={row.ord}
                  className="rounded-lg border bg-card p-3"
                  data-clip-row
                  data-clip-ord={row.ord}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{row.label}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {row.duration ?? 'length unknown'} · {row.owner}
                        {row.primary ? ' · the meeting’s main file' : ''}
                        {row.entry.transcribed ? '' : ' · still transcribing'}
                        {row.entry.alignment === 'aligning' ? ' · lining it up…' : ''}
                      </div>
                      {row.entry.alignment === 'unaligned' && !row.primary && (
                        <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400" data-clip-unaligned>
                          Added from the same calendar event, not lined up yet — set its offset below.
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={!canMutate || !!row.removeBlockedReason || busy}
                      title={row.removeBlockedReason ?? 'Take this recording out of the meeting'}
                      aria-label={`Remove ${row.label}`}
                      onClick={() => removeClip(row.ord)}
                      className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                      data-clip-remove
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      Starts at
                      <Input
                        value={draft ?? formatTimestamp(row.entry.offsetMs)}
                        disabled={!canMutate || busy}
                        onChange={(e) =>
                          setOffsetDraft((d) => ({ ...d, [row.ord]: e.target.value }))
                        }
                        onBlur={(e) => {
                          if (draft === undefined) return;
                          patchOffset(row.ord, e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') {
                            setOffsetDraft((d) => {
                              const next = { ...d };
                              delete next[row.ord];
                              return next;
                            });
                          }
                        }}
                        aria-label={`Offset of ${row.label}`}
                        className="h-7 w-24 font-mono text-xs tabular-nums"
                        data-clip-offset
                      />
                    </label>

                    <div
                      className="flex flex-wrap items-center gap-1"
                      role="group"
                      aria-label={`Text of ${row.label}`}
                    >
                      {POLICY_CHOICES.map((choice) => {
                        const blocked =
                          !!row.policyBlockedReason && choice.value !== 'exclude';
                        const active = row.policy === choice.value;
                        return (
                          <button
                            key={choice.value}
                            type="button"
                            disabled={!canMutate || busy || blocked}
                            aria-pressed={active}
                            title={blocked ? row.policyBlockedReason! : choice.hint}
                            onClick={() => patchPolicy(row.ord, choice.value)}
                            className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                              active
                                ? 'border-primary bg-primary/10 font-medium text-primary'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                            }`}
                            data-clip-policy={choice.value}
                          >
                            {choice.label}
                          </button>
                        );
                      })}
                    </div>
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  </div>

                  {row.removeBlockedReason && (
                    <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                      {row.removeBlockedReason}
                    </p>
                  )}
                  {row.policyBlockedReason && (
                    <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                      {row.policyBlockedReason}
                    </p>
                  )}
                </div>
              );
            })}

            {!combineEnabled && (
              <p className="text-[11px] leading-snug text-muted-foreground">
                Adding or re-placing a recording is not available on this server — this is what the
                meeting holds.
              </p>
            )}
            {combineEnabled && canEdit && (
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canAddRecording}
                  title={addBlockedReason ?? 'Add a second capture of this meeting'}
                  onClick={openPicker}
                  data-add-recording
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add a recording…
                </Button>
                {!canAddRecording && addBlockedReason && (
                  <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                    {addBlockedReason}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------- pick */}
        {step === 'pick' && (
          <div className="space-y-3" data-candidate-list>
            {loadingCandidates && (
              <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Looking for recordings…
              </p>
            )}
            {!loadingCandidates && groups.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing to add. A recording can join this meeting once it is yours and is not
                already part of it — upload it first, then come back here.
              </p>
            )}
            {groups.map((group) => (
              <div key={group.key}>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.title}
                </div>
                <div className="mt-1 space-y-1">
                  {group.candidates.map((c) => (
                    <button
                      key={c.recordingId}
                      type="button"
                      disabled={!c.addable}
                      onClick={() => choose(c)}
                      title={c.blockedReason ?? undefined}
                      className="flex w-full items-start justify-between gap-2 rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                      data-candidate={c.recordingId}
                      data-addable={c.addable ? '1' : '0'}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{c.sourceLabel}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {candidateFacts(c)}
                          {c.meeting?.title ? ` · ${c.meeting.title}` : ''}
                        </span>
                        {c.blockedReason && (
                          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                            {c.blockedReason}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {candidates && (
              <p className="text-[11px] text-muted-foreground">{slotsLeftText(candidates.slotsLeft)}</p>
            )}
            {/* Source (c) of the spec — a fresh upload attached to this
                meeting — answers 501 `upload-deferred` on the server, so it is
                shown as what it is rather than offered and refused. */}
            <div className="rounded-md border border-dashed px-2.5 py-2">
              <div className="text-sm text-muted-foreground">Upload a file…</div>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                Coming soon. For now, upload it as its own recording first — it appears in the list
                above once it has been transcribed.
              </p>
            </div>
          </div>
        )}

        {/* --------------------------------------------------------- align */}
        {step === 'align' && picked && (
          <div className="space-y-3" data-align-step>
            <div className="rounded-lg border bg-card p-3">
              <div className="truncate text-sm font-medium">{picked.sourceLabel}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{candidateFacts(picked)}</div>
            </div>

            {/* The two recordings' EXTENTS at the current offset. The align
                job answers with a number, not with envelopes, so this draws
                what is actually known rather than a waveform it does not have. */}
            {timeline && (
              <div className="rounded-lg border bg-muted/30 p-3" data-align-timeline>
                <div className="space-y-1.5">
                  {timeline.lanes.map((lane) => (
                    <div key={lane.key} className="flex items-center gap-2">
                      <span className="w-28 shrink-0 truncate text-[11px] text-muted-foreground">
                        {lane.label}
                      </span>
                      <span className="relative h-3 flex-1 overflow-hidden rounded-sm bg-background">
                        <span
                          className={`absolute inset-y-0 rounded-sm ${
                            lane.kind === 'new'
                              ? 'bg-primary'
                              : 'bg-muted-foreground/40'
                          } ${lane.openEnded ? 'opacity-70' : ''}`}
                          style={{ left: `${lane.leftPct}%`, width: `${lane.widthPct}%` }}
                          data-lane={lane.kind}
                        />
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {timeline.noOverlap
                    ? 'At this offset the two recordings do not overlap at all — that is almost certainly the wrong number.'
                    : `Meeting runs to ${formatTimestamp(timeline.spanMs)}.`}
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <label className="text-[11px] text-muted-foreground">
                <span className="block">Starts at</span>
                <Input
                  value={offsetText}
                  onChange={(e) => setOffsetText(e.target.value)}
                  aria-label="Offset from the start of the meeting"
                  aria-invalid={!offsetValid}
                  className="mt-1 h-8 w-28 font-mono text-xs tabular-nums"
                  data-align-offset
                />
              </label>
              <div className="flex items-center gap-1" role="group" aria-label="Nudge the offset">
                {NUDGE_STEPS_MS.map((step_) => (
                  <button
                    key={step_}
                    type="button"
                    onClick={() => setOffsetText(formatTimestamp(nudgeOffset(offsetMs, step_)))}
                    className="rounded-md border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    data-nudge={step_}
                  >
                    {nudgeLabel(step_)}
                  </button>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={guess} disabled={guessing} data-align-guess>
                {guessing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Listening…
                  </>
                ) : (
                  <>
                    <Wand2 className="h-3.5 w-3.5" />
                    Guess
                  </>
                )}
              </Button>
            </div>

            {alignLine && (
              <div
                className={`rounded-md border px-2.5 py-2 text-xs ${
                  alignLine.tone === 'ok'
                    ? 'border-primary/40 bg-primary/5'
                    : alignLine.tone === 'warn'
                      ? 'border-amber-400/50 bg-amber-500/5 text-amber-700 dark:text-amber-500'
                      : 'border-muted-foreground/30 bg-muted/40 text-muted-foreground'
                }`}
                data-align-verdict={alignLine.tone}
              >
                <div>{alignLine.text}</div>
                <div className="mt-0.5 font-mono text-[11px] tabular-nums opacity-80">
                  {alignLine.facts}
                </div>
              </div>
            )}

            <div role="group" aria-label="What this recording’s text does">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Its text
              </div>
              <div className="mt-1 space-y-1">
                {POLICY_CHOICES.map((choice) => {
                  const blocked = !picked.transcribed && choice.value !== 'exclude';
                  const active = policy === choice.value;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      disabled={blocked}
                      aria-pressed={active}
                      onClick={() => setPolicy(choice.value)}
                      title={
                        blocked
                          ? 'This recording has no transcript yet — it can join as “Audio only” and its text appears when it finishes.'
                          : choice.hint
                      }
                      className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        active ? 'border-primary bg-primary/5' : 'hover:bg-accent'
                      }`}
                      data-policy-choice={choice.value}
                    >
                      <Check
                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : 'opacity-0'}`}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm">{choice.label}</span>
                        <span className="block text-[11px] leading-snug text-muted-foreground">
                          {choice.hint}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 'align' ? (
            <>
              <Button variant="ghost" onClick={() => setStep('pick')} disabled={adding}>
                Back
              </Button>
              <Button onClick={add} disabled={adding || !offsetValid} data-align-add>
                {adding ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Adding…
                  </>
                ) : (
                  'Add'
                )}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
