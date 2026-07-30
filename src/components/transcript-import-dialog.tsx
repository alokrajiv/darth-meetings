'use client';

import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileUp,
  Loader2,
  Sparkles,
} from 'lucide-react';

interface TranscriptImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}

type Step = 'input' | 'working' | 'done';

/**
 * "Import a transcript (any format)": upload a Teams/Zoom/VTT/docx export or
 * paste raw text — a headless-Claude pass on the server normalizes whatever
 * format it is into utterances, then it behaves like any other transcript
 * (named speakers, notes, sharing).
 */
export function TranscriptImportDialog({ open, onClose, onImported }: TranscriptImportDialogProps) {
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [pasted, setPasted] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [doneTitle, setDoneTitle] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStep('input');
    setError(null);
    setBusy(false);
    setTitle('');
    setPasted('');
    setFile(null);
    setDoneId(null);
    setDoneTitle(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const runImport = async () => {
    if (!file && pasted.trim().length < 20) {
      setError('Pick a file or paste the transcript text first.');
      return;
    }
    setBusy(true);
    setError(null);
    setStep('working');
    try {
      let res: Response;
      if (file) {
        res = await fetch('/api/transcripts/import-text', {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'x-filename': encodeURIComponent(file.name),
          },
          body: file,
        });
      } else {
        res = await fetch('/api/transcripts/import-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: pasted,
            title: title.trim() || undefined,
          }),
        });
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(detail.error || `Import failed (${res.status})`);
      }
      const payload = (await res.json()) as {
        transcript?: { assemblyai_id?: string; title?: string | null };
      };
      setDoneId(payload.transcript?.assemblyai_id ?? null);
      setDoneTitle(payload.transcript?.title ?? null);
      setStep('done');
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setStep('input');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? handleClose() : null)}>
      <DialogContent className="sm:max-w-lg rounded-xl shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            Import a transcript (any format)
          </DialogTitle>
        </DialogHeader>

        {step === 'input' && (
          <div className="space-y-4 min-w-0">
            <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
              Got a transcript from somewhere else — Teams, Zoom, a .vtt caption file, a
              Word export, or just text a colleague sent? Drop it here. AI figures out the
              format and turns it into a proper transcript with named speakers.
            </div>

            <div className="space-y-2">
              <Label>Transcript file</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.vtt,.srt,.docx,.pdf,.json,.csv,.html"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f) setPasted('');
                }}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                >
                  <FileUp className="h-4 w-4 mr-2" />
                  {file ? 'Change file' : 'Choose file'}
                </Button>
                {file && (
                  <span className="text-sm text-muted-foreground truncate">
                    {file.name} · {Math.max(1, Math.round(file.size / 1024))} KB
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="paste-transcript">…or paste the transcript text</Label>
              <textarea
                id="paste-transcript"
                value={pasted}
                onChange={(e) => {
                  setPasted(e.target.value);
                  if (e.target.value.trim()) setFile(null);
                }}
                placeholder={'e.g.\n[10:02] Jane Tan: morning everyone…\nJohn: shall we start?'}
                className="w-full h-40 rounded-md border bg-transparent p-2 text-sm font-mono resize-y"
                disabled={busy}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="import-title">Title (optional)</Label>
              <Input
                id="import-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Defaults to whatever the document says"
                disabled={busy}
              />
            </div>

            {error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )}
          </div>
        )}

        {step === 'working' && (
          <div className="py-8 text-center space-y-3">
            <Sparkles className="h-10 w-10 mx-auto text-primary animate-pulse" />
            <p className="text-sm text-muted-foreground">
              AI is reading the format and normalizing the transcript — usually under a
              minute. Keep this tab open.
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="py-6 text-center space-y-2">
            <CheckCircle2 className="h-10 w-10 mx-auto text-status-ok" />
            <p className="text-sm font-medium">{doneTitle ?? 'Transcript imported'}</p>
            <p className="text-sm text-muted-foreground">
              Imported with named speakers — it&apos;s in your list now.
            </p>
            {doneId && (
              <a href={`/transcript/${doneId}`} className="inline-block">
                <Button size="sm" variant="outline">
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  Open transcript
                </Button>
              </a>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 'input' && (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void runImport()} disabled={busy || (!file && pasted.trim().length < 20)}>
                {busy ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                Import
              </Button>
            </>
          )}
          {step === 'done' && <Button onClick={handleClose}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
