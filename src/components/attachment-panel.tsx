'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlignLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  Paperclip,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { formatSmartDate, type TranscriptAttachment } from '@/lib/format';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function humanSize(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

interface AttachmentPanelProps {
  /** The transcript's assemblyai_id — same id used by the page's other routes. */
  transcriptId: string;
  canEdit: boolean;
  /** Called after any successful add/delete so the page can e.g. bump activity. */
  onChanged?: () => void;
}

/**
 * "Attached context" rail card: files and pasted text that collaborators add
 * to a transcript before generating AI notes. Everything here is visible to
 * anyone with access and gets injected into the AI-notes prompt server-side.
 */
export function AttachmentPanel({ transcriptId, canEdit, onChanged }: AttachmentPanelProps) {
  const [attachments, setAttachments] = useState<TranscriptAttachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  // Add-text dialog
  const [textDialogOpen, setTextDialogOpen] = useState(false);
  const [textTitle, setTextTitle] = useState('');
  const [textBody, setTextBody] = useState('');
  const [savingText, setSavingText] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);

  // File upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Delete
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/attachments`);
      if (!res.ok) return;
      const { attachments: list } = (await res.json()) as {
        attachments: TranscriptAttachment[];
      };
      setAttachments(list ?? []);
    } catch {
      // transient — leave whatever we had
    } finally {
      setLoaded(true);
    }
  }, [transcriptId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleExpanded = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSaveText = async () => {
    const text = textBody.trim();
    if (!text || savingText) return;
    setSavingText(true);
    setTextError(null);
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'text',
          title: textTitle.trim() || 'Pasted notes',
          text,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          body.error ||
            (res.status === 403 ? 'You need edit access to attach context.' : `Failed (${res.status})`)
        );
      }
      setTextDialogOpen(false);
      setTextTitle('');
      setTextBody('');
      await refresh();
      onChanged?.();
    } catch (err) {
      setTextError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingText(false);
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file fires onChange again.
    e.target.value = '';
    if (!file || uploading) return;
    setActionError(null);
    if (file.size > MAX_FILE_BYTES) {
      setActionError('File is larger than 25 MB — attach a smaller file.');
      return;
    }
    setUploading(true);
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/attachments`, {
        method: 'POST',
        headers: {
          // Anything non-JSON routes to the raw-file path server-side.
          'Content-Type': 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (!res.ok) {
        if (res.status === 413) throw new Error('File too large (max 25 MB).');
        if (res.status === 403) throw new Error('You need edit access to attach context.');
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Upload failed (${res.status})`);
      }
      await refresh();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (attachment: TranscriptAttachment) => {
    if (deletingId != null) return;
    if (!window.confirm(`Remove "${attachment.title}" from attached context?`)) return;
    setDeletingId(attachment.id);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/transcripts/${transcriptId}/attachments/${attachment.id}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Delete failed (${res.status})`);
      }
      await refresh();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  // Read-only with nothing attached: keep the page clean.
  if (loaded && attachments.length === 0 && !canEdit) return null;

  return (
    <div id="attachments" className="rounded-lg border bg-card p-3">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 text-left"
        title="Docs, decks, and notes for the team — included when AI notes are generated."
      >
        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Attached context
        </span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          {attachments.length}
        </span>
        {collapsed ? (
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronUp className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {!collapsed && (
        <div className="mt-2 space-y-1">
          {attachments.length === 0 ? (
            canEdit && loaded ? (
              <div className="rounded-md border border-dashed px-2 py-3 text-center text-[11px] text-muted-foreground">
                No context yet — an agenda or deck makes the AI summary sharper.
              </div>
            ) : (
              <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Loading…
              </div>
            )
          ) : (
            attachments.map((a) => {
              const isFile = a.kind === 'file';
              const hasText = !!a.text_content;
              const expanded = expandedIds.has(a.id);
              const extractionFailed =
                isFile && (a.extraction_status === 'failed' || a.extraction_status === 'none');
              const size = humanSize(a.size_bytes);
              const meta = [size, formatSmartDate(a.created_at)]
                .filter(Boolean)
                .join(' · ');
              const tooltipBits: string[] = [];
              if (isFile && a.original_filename && a.original_filename !== a.title) {
                tooltipBits.push(a.original_filename);
              }
              if (a.added_by_email) tooltipBits.push(`added by ${a.added_by_email}`);
              try {
                const d = new Date(a.created_at);
                if (!isNaN(d.getTime())) tooltipBits.push(d.toLocaleString());
              } catch {
                /* ignore */
              }
              return (
                <div key={a.id} className="rounded-md px-1 py-1 hover:bg-muted/60">
                  <div className="flex items-start gap-1.5">
                    {hasText ? (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(a.id)}
                        aria-expanded={expanded}
                        title={expanded ? 'Hide text' : 'Show text'}
                        className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                    ) : (
                      <span className="mt-0.5 w-[18px] shrink-0" />
                    )}
                    {isFile ? (
                      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <AlignLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1" title={tooltipBits.join(' · ') || undefined}>
                      {isFile ? (
                        <a
                          href={`/api/transcripts/${transcriptId}/attachments/${a.id}/download`}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate text-[13px] font-medium hover:underline"
                          title="Download file"
                        >
                          {a.title}
                        </a>
                      ) : (
                        <span className="block truncate text-[13px] font-medium">{a.title}</span>
                      )}
                      <div className="truncate text-[11px] text-muted-foreground">
                        {meta}
                      </div>
                      {extractionFailed && (
                        <div className="text-[11px] italic text-muted-foreground">
                          text not extractable — won&apos;t inform AI notes
                        </div>
                      )}
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleDelete(a)}
                        disabled={deletingId != null}
                        title="Remove attachment"
                        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50 transition-colors"
                      >
                        {deletingId === a.id ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                  {expanded && hasText && (
                    <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs font-mono">
                      {a.text_content}
                    </pre>
                  )}
                </div>
              );
            })
          )}

          {actionError && <p className="text-xs text-destructive">{actionError}</p>}

          {canEdit && (
            <div className="grid grid-cols-2 gap-1.5 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-full text-xs"
                onClick={() => {
                  setTextError(null);
                  setTextDialogOpen(true);
                }}
              >
                <AlignLeft className="h-3 w-3" />
                Add text
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-full text-xs"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : (
                  <Upload className="h-3 w-3" />
                )}
                {uploading ? 'Uploading…' : 'Upload file'}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.pptx,.docx,.txt,.md,.rtf"
                className="hidden"
                onChange={handleFileSelected}
              />
            </div>
          )}
        </div>
      )}

      <Dialog open={textDialogOpen} onOpenChange={(v) => !savingText && setTextDialogOpen(v)}>
        <DialogContent className="max-w-lg rounded-xl shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Add text context</DialogTitle>
            <DialogDescription>
              Paste an agenda, background notes, or anything that should inform the AI
              summary. Visible to everyone with access.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={textTitle}
              placeholder="Title (optional — defaults to “Pasted notes”)"
              disabled={savingText}
              onChange={(e) => setTextTitle(e.target.value)}
              className="h-9"
            />
            <Textarea
              autoFocus
              value={textBody}
              placeholder="Paste or type the context here…"
              rows={8}
              disabled={savingText}
              onChange={(e) => setTextBody(e.target.value)}
              className="text-sm"
            />
            {textError && <p className="text-xs text-destructive">{textError}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setTextDialogOpen(false)}
              disabled={savingText}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveText} disabled={savingText || !textBody.trim()}>
              {savingText ? (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
