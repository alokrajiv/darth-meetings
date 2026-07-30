'use client';

import { useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { formatDuration } from '@/lib/format';
import { Download, Search, AlertCircle, CheckCircle2 } from 'lucide-react';

interface ImportableTranscript {
  id: string;
  created: string | null;
  status: string;
  audio_duration: number | null;
  audio_url: string | null;
}

interface ImportResult {
  id: string;
  ok: boolean;
  hasAudio?: boolean;
  error?: string;
}

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful import so the parent can refresh the list. */
  onImported?: () => void;
}

type Step = 'enter-key' | 'pick' | 'importing' | 'done';

/**
 * Dialog for "Import from my AssemblyAI key".
 *
 * Flow: paste key → list endpoint runs → user picks transcripts → execute
 * endpoint runs → done. The key is held only in component state for the
 * lifetime of the dialog. Closing the dialog clears it.
 */
export function ImportDialog({ open, onClose, onImported }: ImportDialogProps) {
  const [step, setStep] = useState<Step>('enter-key');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [transcripts, setTranscripts] = useState<ImportableTranscript[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ImportResult[]>([]);

  const reset = () => {
    setStep('enter-key');
    setApiKey('');
    setError(null);
    setBusy(false);
    setTranscripts([]);
    setSelected(new Set());
    setResults([]);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSearch = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/import/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error || `Search failed (${res.status})`);
      }
      const { transcripts } = (await res.json()) as { transcripts: ImportableTranscript[] };
      setTranscripts(transcripts);
      // Default-select all completed transcripts.
      setSelected(new Set(transcripts.filter((t) => t.status === 'completed').map((t) => t.id)));
      setStep('pick');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === transcripts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(transcripts.map((t) => t.id)));
    }
  };

  const handleImport = async () => {
    if (selected.size === 0) {
      setError('Pick at least one transcript');
      return;
    }
    setError(null);
    setBusy(true);
    setStep('importing');
    try {
      // Pass full metadata (esp. `created` date) since the AAI SDK's
      // transcripts.get() doesn't include it — only list() does.
      const selectedTranscripts = transcripts
        .filter((t) => selected.has(t.id))
        .map((t) => ({ id: t.id, created: t.created }));
      const res = await fetch('/api/import/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, transcripts: selectedTranscripts }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error || `Import failed (${res.status})`);
      }
      const { results } = (await res.json()) as { results: ImportResult[] };
      setResults(results);
      setStep('done');
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setStep('pick');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? handleClose() : null)}>
      <DialogContent className="sm:max-w-md rounded-xl shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            Import from your AssemblyAI key
          </DialogTitle>
        </DialogHeader>

        {step === 'enter-key' && (
          <div className="space-y-4 py-2">
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="font-medium mb-1">Bring across transcripts you already have</p>
              <p className="text-muted-foreground">
                If you (or someone on your team) already used AssemblyAI from your own account,
                paste that API key here. We&apos;ll list what&apos;s in that account and let you
                pick what to import.
              </p>
              <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                <li>Your key is used in memory only — never saved to the database, never logged.</li>
                <li>
                  Audio playback for imported transcripts only works if AssemblyAI still has
                  the bytes (their retention is short — old transcripts often have no audio).
                </li>
                <li>Company spelling glossary is applied to imported content automatically.</li>
              </ul>
            </div>
            <div className="space-y-2">
              <Label htmlFor="aai-key">AssemblyAI API key</Label>
              <Input
                id="aai-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your AAI API key"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && apiKey.length >= 8) handleSearch();
                }}
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

        {step === 'pick' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {transcripts.length} transcript{transcripts.length === 1 ? '' : 's'} found ·{' '}
                {selected.size} selected
              </p>
              <Button variant="outline" size="sm" onClick={toggleAll}>
                {selected.size === transcripts.length ? 'Select none' : 'Select all'}
              </Button>
            </div>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border">
              {transcripts.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No transcripts found in that account.
                </p>
              ) : (
                <ul className="divide-y">
                  {transcripts.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 p-3">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => toggleOne(t.id)}
                        className="h-4 w-4"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{t.id.substring(0, 8)}…</span>
                          <Badge variant="outline" className="text-[10px]">
                            {t.status}
                          </Badge>
                          {t.audio_duration && (
                            <span className="text-xs text-muted-foreground">
                              {formatDuration(t.audio_duration)}
                            </span>
                          )}
                        </div>
                        {t.created && (
                          <p className="text-xs text-muted-foreground">
                            {new Date(t.created).toLocaleString()}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )}
          </div>
        )}

        {step === 'importing' && (
          <div className="py-8 text-center">
            <Download className="h-10 w-10 animate-bounce mx-auto text-primary" />
            <p className="mt-3 text-sm text-muted-foreground">
              Importing {selected.size} transcript{selected.size === 1 ? '' : 's'}...
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-3">
            <p className="text-sm">
              {results.filter((r) => r.ok).length} imported,{' '}
              {results.filter((r) => !r.ok).length} failed.
            </p>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border">
              <ul className="divide-y">
                {results.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 p-3 text-xs">
                    {r.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-status-ok shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                    )}
                    <span className="font-mono">{r.id.substring(0, 8)}…</span>
                    {r.ok && r.hasAudio && (
                      <Badge variant="outline" className="text-[10px]">
                        with audio
                      </Badge>
                    )}
                    {r.ok && !r.hasAudio && (
                      <span className="text-muted-foreground">(no audio)</span>
                    )}
                    {!r.ok && r.error && <span className="text-destructive">{r.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 'enter-key' && (
            <>
              <Button variant="ghost" onClick={handleClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={handleSearch} disabled={busy || apiKey.length < 8}>
                <Search className="h-4 w-4 mr-2" />
                {busy ? 'Searching...' : 'Search'}
              </Button>
            </>
          )}
          {step === 'pick' && (
            <>
              <Button variant="ghost" onClick={() => setStep('enter-key')} disabled={busy}>
                Back
              </Button>
              <Button onClick={handleImport} disabled={busy || selected.size === 0}>
                <Download className="h-4 w-4 mr-2" />
                Import {selected.size}
              </Button>
            </>
          )}
          {step === 'done' && <Button onClick={handleClose}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
