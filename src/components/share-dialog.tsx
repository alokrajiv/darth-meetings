'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, Loader2, Trash2, Users } from 'lucide-react';
import { UserPicker, type PickerPerson } from '@/components/user-picker';
import type { TranscriptShare, TranscriptAccess } from '@/lib/format';

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transcriptId: string;
  /** Current caller's access — only 'owner' can mutate shares. */
  callerAccess: TranscriptAccess;
  /** Fired after a successful add so parent state (e.g. collaborator email
   *  set in the transcript detail page) can update without a full refetch. */
  onSharesChanged?: (shares: TranscriptShare[]) => void;
}

/**
 * Dialog for managing who has access to a transcript. Owner sees the full
 * picker + per-row access controls; collaborators see a read-only list.
 */
export function ShareDialog({
  open,
  onOpenChange,
  transcriptId,
  callerAccess,
  onSharesChanged,
}: ShareDialogProps) {
  const [shares, setShares] = useState<TranscriptShare[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingAccess, setPendingAccess] = useState<'edit' | 'read'>('edit');
  const [pickerKey, setPickerKey] = useState(0); // bump to reset the picker after add
  const [error, setError] = useState<string | null>(null);

  const canManage = callerAccess === 'owner';

  const loadShares = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/transcripts/${transcriptId}/shares`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const { shares: rows } = (await res.json()) as { shares: TranscriptShare[] };
      setShares(rows);
      onSharesChanged?.(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [transcriptId, onSharesChanged]);

  useEffect(() => {
    if (open) loadShares();
  }, [open, loadShares]);

  const handleAdd = async (person: PickerPerson) => {
    if (!person.email) {
      setError(`${person.name} has no email on file — can't share with them.`);
      return;
    }
    try {
      setError(null);
      const res = await fetch(`/api/transcripts/${transcriptId}/shares`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: person.email,
          name: person.name,
          pplId: person.id,
          access: pendingAccess,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed (${res.status})`);
      }
      setPickerKey((k) => k + 1);
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to share');
    }
  };

  const handleAccessChange = async (email: string, access: 'edit' | 'read') => {
    try {
      setError(null);
      const res = await fetch(`/api/transcripts/${transcriptId}/shares`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, access }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update access');
    }
  };

  const handleRemove = async (email: string) => {
    try {
      setError(null);
      const res = await fetch(`/api/transcripts/${transcriptId}/shares`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" /> Access
          </DialogTitle>
          <DialogDescription>
            {canManage
              ? 'Share this transcript with other people in your organisation. Editors can edit text and speaker names; read-only collaborators can only view.'
              : 'People with access to this transcript. Only the owner can change sharing.'}
          </DialogDescription>
        </DialogHeader>

        {canManage && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <UserPicker
                  key={pickerKey}
                  mode="strict"
                  placeholder="Search by name or email…"
                  autoFocus={false}
                  openOnFocus={false}
                  onSelect={(sel) => {
                    if (sel.type === 'person') handleAdd(sel.person);
                  }}
                />
              </div>
              <div className="inline-flex rounded-md border bg-background p-0.5">
                <button
                  type="button"
                  onClick={() => setPendingAccess('edit')}
                  className={`rounded px-2 py-1 text-xs ${
                    pendingAccess === 'edit' ? 'bg-muted font-medium' : 'text-muted-foreground'
                  }`}
                >
                  Editor
                </button>
                <button
                  type="button"
                  onClick={() => setPendingAccess('read')}
                  className={`rounded px-2 py-1 text-xs ${
                    pendingAccess === 'read' ? 'bg-muted font-medium' : 'text-muted-foreground'
                  }`}
                >
                  Read
                </button>
              </div>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
        )}

        <div className="mt-2 rounded-md border">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
            {shares.length === 0
              ? 'No collaborators yet'
              : `${shares.length} ${shares.length === 1 ? 'person has' : 'people have'} access`}
          </div>
          <div className="max-h-72 divide-y overflow-auto">
            {loading && shares.length === 0 && (
              <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading…
              </div>
            )}
            {shares.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {(s.shared_with_name || s.shared_with_email).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {s.shared_with_name || s.shared_with_email}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {s.shared_with_email}
                  </div>
                </div>
                {canManage ? (
                  <div className="flex items-center gap-1">
                    <select
                      value={s.access}
                      onChange={(e) =>
                        handleAccessChange(s.shared_with_email, e.target.value as 'edit' | 'read')
                      }
                      className="h-7 rounded border bg-background px-1.5 text-xs"
                    >
                      <option value="edit">Editor</option>
                      <option value="read">Read-only</option>
                    </select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600"
                      onClick={() => handleRemove(s.shared_with_email)}
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  <Badge variant="outline" className="text-[10px]">
                    {s.access === 'edit' ? 'Editor' : 'Read-only'}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <Check className="h-4 w-4 mr-1" /> Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
