'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Save } from 'lucide-react';
import type { VocabPayload, CustomSpellingEntry } from '@/lib/format';
import { OFFLINE_TITLE } from '@/lib/offline/offline-types';
import { isNetworkFailure } from '@/lib/offline/offline-fetch';

interface VocabEditorProps {
  title: string;
  description: string;
  initial: VocabPayload;
  onSave: (payload: VocabPayload) => Promise<void>;
  /** Optional metadata to render under the title (e.g. "v3 — edited 2m ago by ..."). */
  meta?: React.ReactNode;
  /** Offline mode / network down: Save is inert (the draft stays editable). */
  disabled?: boolean;
}

/**
 * Reusable card UI for editing a vocab payload (keyterms_prompt +
 * custom_spelling). Used twice on the settings page: once for the user's
 * own vocab, once for the company-wide vocab. Fully controlled; local
 * draft state, calls `onSave` on submit.
 */
export function VocabEditor({ title, description, initial, onSave, meta, disabled = false }: VocabEditorProps) {
  const [keyterms, setKeyterms] = useState<string[]>(initial.keyterms_prompt);
  const [customSpelling, setCustomSpelling] = useState<CustomSpellingEntry[]>(
    initial.custom_spelling
  );
  // For the custom spelling editor we keep `from` as the user types it (a
  // comma-separated string) so they can include commas at typing time.
  const [fromDrafts, setFromDrafts] = useState<string[]>(
    initial.custom_spelling.map((s) => s.from.join(', '))
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const addKeytermRow = () => {
    setKeyterms((prev) => [...prev, '']);
  };
  const removeKeytermRow = (idx: number) => {
    setKeyterms((prev) => prev.filter((_, i) => i !== idx));
  };
  const updateKeytermRow = (idx: number, value: string) => {
    setKeyterms((prev) => prev.map((r, i) => (i === idx ? value : r)));
  };

  const addSpellingRow = () => {
    setCustomSpelling((prev) => [...prev, { to: '', from: [] }]);
    setFromDrafts((prev) => [...prev, '']);
  };
  const removeSpellingRow = (idx: number) => {
    setCustomSpelling((prev) => prev.filter((_, i) => i !== idx));
    setFromDrafts((prev) => prev.filter((_, i) => i !== idx));
  };
  const updateSpellingTo = (idx: number, to: string) => {
    setCustomSpelling((prev) => prev.map((r, i) => (i === idx ? { ...r, to } : r)));
  };
  const updateSpellingFromDraft = (idx: number, draft: string) => {
    setFromDrafts((prev) => prev.map((d, i) => (i === idx ? draft : d)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const cleanedSpelling: CustomSpellingEntry[] = customSpelling.map((row, i) => ({
        to: row.to.trim(),
        from: (fromDrafts[i] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }));
      const cleanedKeyterms = keyterms
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      await onSave({ keyterms_prompt: cleanedKeyterms, custom_spelling: cleanedSpelling });
      setSavedAt(Date.now());
      setKeyterms(cleanedKeyterms);
      setCustomSpelling(cleanedSpelling);
      setFromDrafts(cleanedSpelling.map((s) => s.from.join(', ')));
    } catch (err) {
      console.error('Vocab save failed:', err);
      setSaveError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Failed to save vocab');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{title}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            {meta}
          </div>
          <Button onClick={handleSave} disabled={saving || disabled} size="sm" title={disabled ? OFFLINE_TITLE : undefined}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
        {saveError && <p className="mt-2 text-xs text-destructive">{saveError}</p>}
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Keyterms prompt */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              Key terms{' '}
              <Badge variant="outline" className="ml-1 text-[10px]">
                {keyterms.length}
              </Badge>
            </h3>
            <Button variant="outline" size="sm" onClick={addKeytermRow}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Words or phrases (up to 6 words each) to bias AssemblyAI&apos;s
            recognition toward — names, jargon, product terms. Uses AAI&apos;s
            new <code className="font-mono">keyterms_prompt</code> feature on
            the Universal speech model.
          </p>
          {keyterms.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No key terms yet.</p>
          ) : (
            <div className="space-y-2">
              {keyterms.map((term, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={term}
                    onChange={(e) => updateKeytermRow(idx, e.target.value)}
                    placeholder="Word or phrase"
                    className="flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => removeKeytermRow(idx)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Custom spelling */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              Custom spelling{' '}
              <Badge variant="outline" className="ml-1 text-[10px]">
                {customSpelling.length}
              </Badge>
            </h3>
            <Button variant="outline" size="sm" onClick={addSpellingRow}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Replace any of the &quot;from&quot; variants with the canonical &quot;to&quot;
            spelling. Comma-separate multiple variants. Applied during transcription and as a
            post-import pass.
          </p>
          {customSpelling.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No spellings added yet.</p>
          ) : (
            <div className="space-y-3">
              {customSpelling.map((row, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs text-muted-foreground">Replace with</Label>
                    <Input
                      value={row.to}
                      onChange={(e) => updateSpellingTo(idx, e.target.value)}
                      placeholder="e.g. Ziyuan"
                    />
                  </div>
                  <div className="flex-[2] space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      Variants to find (comma-separated)
                    </Label>
                    <Input
                      value={fromDrafts[idx] ?? ''}
                      onChange={(e) => updateSpellingFromDraft(idx, e.target.value)}
                      placeholder="e.g. zee yuen, zeeyuan, zee won"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeSpellingRow(idx)}
                    className="mt-6 text-muted-foreground hover:text-destructive"
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {savedAt && (
          <p className="text-xs text-muted-foreground">
            Saved {new Date(savedAt).toLocaleTimeString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
