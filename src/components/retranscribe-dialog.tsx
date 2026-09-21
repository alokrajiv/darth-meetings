'use client';

import { useEffect, useState } from 'react';
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
import { Label } from '@/components/ui/label';
import {
  DEFAULT_SPEECH_MODEL,
  SUBMIT_SPEECH_MODELS,
  speechModelLabel,
} from '@/lib/aai-language';
import { languageChoices } from '@/lib/transcription-copy';
import { sameTranscriptionSettings } from '@/lib/transcriptions';
import type {
  RetranscribeRequest,
  TranscriptionLanguageChoice,
  TranscriptionVersion,
} from '@/lib/transcriptions';
import type { RetranscribeOutcome } from '@/hooks/use-transcriptions';
import { AudioWaveform } from 'lucide-react';

const FIELD_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

interface RetranscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version the meeting is reading now — the language to offer, and
   * what "the same settings" means. */
  active: TranscriptionVersion | null;
  submitting: boolean;
  onSubmit: (req: RetranscribeRequest) => Promise<RetranscribeOutcome>;
}

/**
 * "Transcribe again" — a new transcription of the SAME meeting
 * (docs/recordings-phase2-spec.md §UI). Two choices only: what language to
 * hear it as, and which model runs. The meeting stays readable on its
 * current version the whole time, which is what makes this a calm action.
 */
export function RetranscribeDialog({
  open,
  onOpenChange,
  active,
  submitting,
  onSubmit,
}: RetranscribeDialogProps) {
  const [languageCode, setLanguageCode] = useState<TranscriptionLanguageChoice>('auto');
  const [speechModel, setSpeechModel] = useState<string>(DEFAULT_SPEECH_MODEL);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The server said these settings repeat the current version; the next
   * press sends `force`. Also set locally, before asking. */
  const [confirming, setConfirming] = useState(false);
  // Focus goes back to "Transcribe again…" on close — handled for every dialog
  // in the app by `components/ui/dialog.tsx` (see `useOpenerFocus` there for
  // why Radix does not do it), including the case where a submit has just
  // disabled the opener. Nothing to do here.

  // Fresh choices every time it opens — the defaults are the honest ones.
  useEffect(() => {
    if (!open) return;
    setLanguageCode('auto');
    setSpeechModel(DEFAULT_SPEECH_MODEL);
    setReason('');
    setError(null);
    setConfirming(false);
  }, [open]);

  const choices = languageChoices(active?.languageCode);
  const repeats = sameTranscriptionSettings(active, { speechModel, languageCode });
  const mustConfirm = confirming || repeats;

  const submit = async () => {
    setError(null);
    try {
      const res = await onSubmit({
        speechModel,
        languageCode,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(mustConfirm ? { force: true } : {}),
      });
      if (res.kind === 'same-settings') {
        // Our own check disagreed with the server's — ask, don't guess.
        setConfirming(true);
        return;
      }
      if (res.kind === 'busy') {
        setError('A transcription is already running on this meeting.');
        return;
      }
      if (res.kind === 'new-row') {
        window.location.href = `/transcript/${res.newId}`;
        return;
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start it');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Transcribe again</DialogTitle>
          <DialogDescription className="text-xs">
            A new version of what was heard, on this same meeting. Every version is kept and you
            can switch back.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="retranscribe-language">Language</Label>
            <select
              id="retranscribe-language"
              className={FIELD_CLASS}
              value={languageCode}
              disabled={submitting}
              onChange={(e) => {
                setLanguageCode(e.target.value);
                setConfirming(false);
              }}
            >
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Naming the language stops AssemblyAI guessing it wrong — the usual reason a meeting
              comes back reading like a translation.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="retranscribe-model">Model</Label>
            <select
              id="retranscribe-model"
              className={FIELD_CLASS}
              value={speechModel}
              disabled={submitting}
              onChange={(e) => {
                setSpeechModel(e.target.value);
                setConfirming(false);
              }}
            >
              {SUBMIT_SPEECH_MODELS.map((m) => (
                <option key={m} value={m}>
                  {speechModelLabel(m)}
                  {m === DEFAULT_SPEECH_MODEL ? ' — the default' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="retranscribe-reason">Why (optional)</Label>
            <Input
              id="retranscribe-reason"
              value={reason}
              disabled={submitting}
              maxLength={120}
              placeholder="e.g. wrong language, newer model"
              onChange={(e) => setReason(e.target.value)}
              className="h-9 text-sm"
            />
          </div>

          <p className="text-[11px] leading-snug text-muted-foreground">
            A few minutes, and it uses transcription credit. This meeting stays readable on its
            current version while the new one runs.
          </p>

          {mustConfirm && (
            <p className="rounded-md border border-amber-400/50 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              Same model and language as the version you are reading — it will almost certainly
              come back the same. Press &ldquo;Transcribe again anyway&rdquo; if that is what you
              want, or change the language or the model above.
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={submitting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={submitting} onClick={() => void submit()}>
            <AudioWaveform className="h-4 w-4" />
            {submitting
              ? 'Starting…'
              : mustConfirm
                ? 'Transcribe again anyway'
                : 'Transcribe again'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
