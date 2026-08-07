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
import { Badge } from '@/components/ui/badge';
import { Loader2, User } from 'lucide-react';
import type { PickerPerson } from '@/components/user-picker';

interface AddPersonDialogProps {
  open: boolean;
  /** Pre-filled name when the dialog opens (the custom text from the picker). */
  initialName: string;
  /** The user committed a person (either newly created or matched to an existing record). */
  onCreated: (person: PickerPerson) => void;
  /**
   * User chose "Use as label only" — no person record is created. The raw
   * typed name should be saved as the speaker's customName and that's it.
   */
  onUseAsLabel: (name: string) => void;
  /** User cancelled — revert to the previous state. */
  onCancel: () => void;
}

/**
 * Dialog that promotes a custom speaker name into a first-class person.
 * Two-step flow:
 *
 *  1. Form — user enters name + email, clicks Add person.
 *  2. If POST /api/people returns 409, switch to a confirmation view that
 *     says "this email already belongs to {existing.name}" and offers a
 *     button to use the existing record instead.
 *
 * The "Use as label only" button exists for the anonymous-speaker case
 * (e.g. "Interviewer #1") where we don't have an email or don't want to
 * track the person.
 */
export function AddPersonDialog({
  open,
  initialName,
  onCreated,
  onUseAsLabel,
  onCancel,
}: AddPersonDialogProps) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<PickerPerson | null>(null);

  // Reset the form every time the dialog opens with a new initial name.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setEmail('');
      setError(null);
      setExisting(null);
      setLoading(false);
    }
  }, [open, initialName]);

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Please enter a name.');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email.');
      return;
    }
    try {
      setLoading(true);
      const res = await fetch('/api/people', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      if (res.status === 409) {
        const body = (await res.json()) as { person: PickerPerson };
        setExisting(body.person);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed (${res.status})`);
      }
      const body = (await res.json()) as { person: PickerPerson };
      onCreated(body.person);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create person');
    } finally {
      setLoading(false);
    }
  };

  const handleUseExisting = () => {
    if (!existing) return;
    onCreated(existing);
  };

  const handleBack = () => {
    setExisting(null);
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-md">
        {existing ? (
          <>
            <DialogHeader>
              <DialogTitle>Email already registered</DialogTitle>
              <DialogDescription>
                <span className="font-medium">{email}</span> already belongs to
                someone in {existing.source === 'trames' ? 'the Trames directory' : 'your people list'}.
                Use that person as the speaker?
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                <User className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{existing.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {existing.source === 'trames' ? 'Trames' : 'Custom'}
                  </Badge>
                </div>
                <div className="truncate text-xs text-muted-foreground">{existing.email}</div>
                {existing.team && (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {existing.team}
                    {existing.role ? ` · ${existing.role}` : ''}
                  </div>
                )}
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={handleBack}>
                Back
              </Button>
              <Button onClick={handleUseExisting}>Use {existing.name.split(/\s+/)[0]}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add a person</DialogTitle>
              <DialogDescription>
                Give this speaker a persistent identity so they can be shared,
                searched, and tagged consistently across transcripts.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="person-name">Name</Label>
                <Input
                  id="person-name"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="person-email">Email</Label>
                <Input
                  id="person-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@example.com"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                onClick={() => onUseAsLabel(name.trim() || initialName)}
                disabled={loading}
                title="Save the name as a plain label without creating a person"
              >
                Use as label only
              </Button>
              <Button variant="outline" onClick={onCancel} disabled={loading}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Adding…
                  </>
                ) : (
                  'Add person'
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
