'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { UserPicker } from '@/components/user-picker';
import { networkErrorMessage } from '@/lib/fetch-errors';
import {
  describePattern,
  editorToPatterns,
  patternsToEditor,
  validatePatterns,
  type PatternEditorState,
  type SeriesPattern,
} from '@/lib/series-patterns';
import { ArrowRightLeft, Crown, Eye, Loader2, PenLine, Plus, Tag, UserCheck, X } from 'lucide-react';

/**
 * The curated-series definition, shared by the /series "New series" form and
 * the series dialog's edit mode (docs/curated-series-spec.md §2, §4, §6):
 * name, description, the patterns editor (one title regex per line + an
 * optional invite rule) with a server Preview, default labels by path
 * (created on save if missing), and priority. Plus the owner / editors /
 * followers sections (v2 — a series runs as its OWNER, spec §11.11).
 *
 * Validation runs here with the same pure function the server runs
 * (lib/series-patterns validatePatterns), so a bad regex is caught as you
 * type; the server is still the gate.
 */

export interface SeriesDefinitionValues {
  title: string;
  description: string;
  patterns: SeriesPattern[];
  priority: number;
  /** Label paths, e.g. "Team/Data". */
  labels: string[];
}

/** lib/series-permissions SeriesPermissions, as the API serves it. The
 * server decides every one of these (it alone knows who is an auditor). */
export interface SeriesPermissionsView {
  role: 'owner' | 'editor' | 'follower' | 'auditor' | null;
  see: boolean;
  edit: boolean;
  manageEditors: boolean;
  manageFollowers: boolean;
  transfer: boolean;
  delete: boolean;
  isOwner: boolean;
  isEditor: boolean;
  isFollower: boolean;
  isAuditor: boolean;
  ownerIsAuditor: boolean;
}

export interface SeriesFollowerView {
  email: string;
  name: string | null;
  added_by_email: string;
  added_at: string;
}

export interface SeriesOwnerView {
  email: string | null;
  name: string | null;
  isAuditor: boolean;
}

const firstName = (o: SeriesOwnerView | null | undefined) =>
  o ? (o.name || o.email || 'the owner') : 'the owner';

/** §11.11 reach note under the patterns. */
export function reachNote(owner: SeriesOwnerView | null | undefined): string {
  if (owner?.isAuditor) return 'Auditor series — matches every meeting.';
  return `Matches only meetings ${firstName(owner)} can open.`;
}

// ---------------------------------------------------------------------------
// Label paths
// ---------------------------------------------------------------------------

/** Default labels by path: pick an existing one or type a new path — it is
 * created (with its parents) when the series is saved. */
export function LabelPathsInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (paths: string[]) => void;
}) {
  const [catalog, setCatalog] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/labels')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { labels?: Array<{ path: string }> } | null) => {
        if (!cancelled && j?.labels) setCatalog(j.labels.map((l) => l.path));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const add = () => {
    const path = draft
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('/');
    if (!path) return;
    if (!value.some((v) => v.toLowerCase() === path.toLowerCase())) onChange([...value, path]);
    setDraft('');
  };
  const exists = (p: string) => catalog.some((c) => c.toLowerCase() === p.toLowerCase());
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-[11px]"
              title={exists(p) ? p : `${p} — will be created`}
            >
              <Tag className="h-3 w-3 text-muted-foreground" />
              {p}
              {!exists(p) && <span className="text-muted-foreground">(new)</span>}
              <button
                type="button"
                className="rounded text-muted-foreground hover:text-destructive"
                onClick={() => onChange(value.filter((v) => v !== p))}
                title="Remove this default label"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <Input
          value={draft}
          list="series-label-paths"
          placeholder="Label path, e.g. Team/Data or AM Briefing/Jacq"
          className="h-8 text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <datalist id="series-label-paths">
          {catalog.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={add}>
          <Plus className="h-3 w-3" /> Add
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The definition form
// ---------------------------------------------------------------------------

interface PreviewResult {
  /** Matches within the reach previewed — the caller's own, or (editing an
   * existing series) its owner's. Never org-wide. */
  matched: number;
  visibleToYou: number;
  sample: Array<{ assemblyai_id: string; title: string | null; when: string }>;
  reachOf?: 'you' | 'owner';
}

export function SeriesDefinitionForm({
  initial,
  seriesId,
  reach,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: SeriesDefinitionValues;
  /** Editing an existing series: the preview runs within its owner's reach. */
  seriesId?: number;
  /** One line under the patterns: what this series can match. */
  reach?: string;
  submitLabel: string;
  /** Resolves to an error message, or null on success. */
  onSubmit: (values: SeriesDefinitionValues, changed: { matching: boolean }) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [editor, setEditor] = useState<PatternEditorState>(() => patternsToEditor(initial.patterns));
  const [priority, setPriority] = useState(String(initial.priority));
  const [labels, setLabels] = useState<string[]>(initial.labels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const validated = useMemo(() => validatePatterns(editorToPatterns(editor)), [editor]);
  const priorityNum = Number(priority);
  const priorityOk = Number.isInteger(priorityNum) && priorityNum >= 0 && priorityNum <= 1000;

  const runPreview = async () => {
    if (!validated.ok) return;
    setPreviewBusy(true);
    try {
      const res = await fetch('/api/series/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns: validated.patterns, ...(seriesId ? { seriesId } : {}) }),
      });
      const j = (await res.json().catch(() => null)) as (PreviewResult & { error?: string }) | null;
      if (!res.ok || !j) throw new Error(j?.error ?? `Preview failed (${res.status})`);
      setPreview(j);
    } catch (err) {
      setError(networkErrorMessage(err, 'Preview failed'));
    } finally {
      setPreviewBusy(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!title.trim()) return setError('Give the series a name');
    if (!validated.ok) return setError(validated.error);
    if (!priorityOk) return setError('Priority is a whole number from 0 to 1000 (lower wins)');
    const changedMatching =
      JSON.stringify(validated.patterns) !== JSON.stringify(initial.patterns) ||
      priorityNum !== initial.priority;
    setBusy(true);
    const err = await onSubmit(
      {
        title: title.trim(),
        description: description.trim(),
        patterns: validated.patterns,
        priority: priorityNum,
        labels,
      },
      { matching: changedMatching }
    );
    setBusy(false);
    if (err) setError(err);
  };

  const inv = editor.invite;
  const setInv = (patch: Partial<PatternEditorState['invite']>) =>
    setEditor((e) => ({ ...e, invite: { ...e.invite, ...patch } }));

  return (
    <div className="space-y-3 text-sm">
      <label className="block space-y-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Name</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8" maxLength={120} />
      </label>
      <label className="block space-y-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Description
        </span>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="h-8"
          maxLength={300}
          placeholder="One line: what this series is"
        />
      </label>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Patterns
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {reach ?? 'Matches only meetings you can open (an auditor’s series: every meeting).'}
        </p>
        <Textarea
          value={editor.titles}
          onChange={(e) => setEditor((s) => ({ ...s, titles: e.target.value }))}
          placeholder={'One title regex per line (case-insensitive), e.g.\n^AI - Daily\n^Data (weekly|QA)\\b'}
          className="min-h-20 font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          Matched against the calendar event’s title (else the meeting’s own title). A meeting
          matching ANY pattern belongs to the series.
        </p>
        <div className="rounded-md border p-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={inv.enabled}
              onChange={(e) => setInv({ enabled: e.target.checked })}
            />
            Also match by who is on the invite
          </label>
          {inv.enabled && (
            <div className="mt-2 grid gap-1.5 text-xs">
              <Input
                value={inv.all}
                onChange={(e) => setInv({ all: e.target.value })}
                placeholder="Everyone of these is invited (emails, comma-separated)"
                className="h-7 text-xs"
              />
              <Input
                value={inv.any}
                onChange={(e) => setInv({ any: e.target.value })}
                placeholder="…and at least one of these (optional)"
                className="h-7 text-xs"
              />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={inv.internalOnly}
                    onChange={(e) => setInv({ internalOnly: e.target.checked })}
                  />
                  Nobody from outside Tramés
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={inv.recurringOnly}
                    onChange={(e) => setInv({ recurringOnly: e.target.checked })}
                  />
                  Recurring events only
                </label>
                <label className="flex items-center gap-1">
                  At most
                  <Input
                    value={inv.maxPeople}
                    onChange={(e) => setInv({ maxPeople: e.target.value.replace(/[^\d]/g, '') })}
                    className="h-6 w-12 px-1 text-xs"
                  />
                  people
                </label>
              </div>
            </div>
          )}
        </div>
        {!validated.ok && <p className="text-[11px] text-destructive">{validated.error}</p>}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={!validated.ok || validated.patterns.length === 0 || previewBusy}
            onClick={() => void runPreview()}
            title="What would these patterns match within this series' reach?"
          >
            {previewBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
            Preview
          </Button>
          {preview && (
            <span className="text-[11px] text-muted-foreground">
              {preview.reachOf === 'owner'
                ? `${preview.matched} meeting${preview.matched === 1 ? '' : 's'} the owner can open match · ${preview.visibleToYou} you can open`
                : `${preview.matched} of the meetings you can open match`}
            </span>
          )}
        </div>
        {preview && preview.sample.length > 0 && (
          <div className="divide-y rounded-md border text-xs">
            {preview.sample.map((s) => (
              <a
                key={s.assemblyai_id}
                href={`/transcript/${s.assemblyai_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-2 py-1 hover:bg-muted"
              >
                <span className="w-24 shrink-0 tabular-nums text-muted-foreground">
                  {new Date(s.when).toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' })}
                </span>
                <span className="min-w-0 truncate">{s.title || 'Untitled meeting'}</span>
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Default labels
        </span>
        <LabelPathsInput value={labels} onChange={setLabels} />
        <p className="text-[11px] text-muted-foreground">
          Every meeting in the series carries these; a meeting that leaves the series loses them
          (labels someone added by hand stay).
        </p>
      </div>

      <label className="block space-y-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Priority
        </span>
        <Input
          value={priority}
          onChange={(e) => setPriority(e.target.value.replace(/[^\d]/g, ''))}
          className="h-8 w-24"
        />
        <span className="block text-[11px] text-muted-foreground">
          Display order only: a meeting can be in several series — the lowest number shows first (and
          decides which series’ auto-import owns an occurrence).
        </span>
      </label>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 border-t pt-3">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => void submit()} disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only summary (dialog view mode, index rows)
// ---------------------------------------------------------------------------

export function PatternList({ patterns }: { patterns: SeriesPattern[] }) {
  if (patterns.length === 0) {
    return <p className="text-xs text-muted-foreground">No patterns — manual members only.</p>;
  }
  return (
    <ul className="space-y-0.5">
      {patterns.map((p, i) => (
        <li key={i} className="font-mono text-[11px] text-foreground/80">
          {describePattern(p)}
        </li>
      ))}
    </ul>
  );
}

export function LabelChipsStatic({ labels }: { labels: Array<{ path: string; color?: string | null }> }) {
  if (labels.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {labels.map((l) => (
        <Badge key={l.path} variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-normal">
          <Tag className="h-2.5 w-2.5" style={l.color ? { color: l.color } : undefined} />
          {l.path}
        </Badge>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// People: owner, editors, followers (§11.1 role table, §11.11)
// ---------------------------------------------------------------------------

/** POST/DELETE helper for the people routes — the server's own words on a
 * refusal (e.g. "its editors must be auditors too"). */
async function peopleCall(url: string, init: RequestInit, fallback: string): Promise<void> {
  const res = await fetch(url, init);
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error ?? `${fallback} (${res.status})`);
}

function PersonChip({
  label,
  title,
  onRemove,
  removeTitle,
  busy,
}: {
  label: string;
  title: string;
  onRemove?: () => void;
  removeTitle?: string;
  busy?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px]"
      title={title}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          disabled={busy}
          className="rounded text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          title={removeTitle}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/**
 * Owner + editors. Everyone who can see the series sees who runs it; the
 * owner and editors add/remove editors; the owner hands the series on
 * (transfer — the old owner becomes an editor). On an auditor-owned series
 * the server refuses non-auditor editors and explains why.
 */
export function SeriesOwnershipSection({
  seriesId,
  owner,
  editors,
  permissions,
  viewerEmail,
  onChanged,
}: {
  seriesId: number;
  owner: SeriesOwnerView | null;
  editors: SeriesFollowerView[];
  permissions: SeriesPermissionsView | null;
  viewerEmail: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [transferring, setTransferring] = useState(false);
  const me = viewerEmail?.trim().toLowerCase() ?? null;

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setPickerKey((k) => k + 1);
      onChanged();
    } catch (err) {
      setError(networkErrorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };
  const addEditor = (email: string, name: string | null) =>
    run(
      () =>
        peopleCall(
          `/api/series/${seriesId}/editors`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name }) },
          "Couldn't add the editor"
        ),
      "Couldn't add the editor"
    );
  const removeEditor = (email: string) => {
    if (!confirm(me === email ? 'Stop editing this series?' : `Remove ${email} as an editor?`)) return;
    void run(
      () =>
        peopleCall(
          `/api/series/${seriesId}/editors?email=${encodeURIComponent(email)}`,
          { method: 'DELETE' },
          "Couldn't remove the editor"
        ),
      "Couldn't remove the editor"
    );
  };
  const transfer = (email: string, name: string | null) => {
    if (
      !confirm(
        `Hand this series to ${name || email}? They become its owner — it will then match only the meetings THEY can open, and their followers get only what they own or edit. You stay on as an editor.`
      )
    )
      return;
    void run(
      () =>
        peopleCall(
          `/api/series/${seriesId}/transfer`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name }) },
          "Couldn't transfer the series"
        ).then(() => setTransferring(false)),
      "Couldn't transfer the series"
    );
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Crown className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Owner</span>
        <PersonChip
          label={`${owner?.name || owner?.email || 'unknown'}${owner?.email && owner.email === me ? ' (you)' : ''}`}
          title={owner?.email ?? 'No owner recorded'}
        />
        {owner?.isAuditor && (
          <span className="text-[11px] text-amber-700 dark:text-amber-400">auditor — reaches every meeting</span>
        )}
        {permissions?.transfer && !transferring && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={() => setTransferring(true)}
          >
            <ArrowRightLeft className="h-3 w-3" /> Transfer ownership
          </Button>
        )}
      </div>
      {transferring && (
        <div className="flex max-w-md items-center gap-2">
          <div className="flex-1">
            <UserPicker
              key={`t-${pickerKey}`}
              mode="strict"
              placeholder="New owner — name or email…"
              autoFocus
              openOnFocus={false}
              compact
              onSelect={(sel) => {
                if (sel.type === 'person' && sel.person.email) transfer(sel.person.email, sel.person.name);
              }}
            />
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setTransferring(false)}>
            Cancel
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <PenLine className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Editors</span>
        {editors.length === 0 ? (
          <span className="text-xs text-muted-foreground">none</span>
        ) : (
          editors.map((e) => (
            <PersonChip
              key={e.email}
              label={e.name || e.email}
              title={`${e.email} · added by ${e.added_by_email}`}
              busy={busy}
              onRemove={
                permissions?.manageEditors || (me && me === e.email) ? () => removeEditor(e.email) : undefined
              }
              removeTitle={me === e.email ? 'Stop editing' : 'Remove editor'}
            />
          ))
        )}
        <span className="text-[11px] text-muted-foreground">
          edit the definition, manage editors and followers
          {permissions?.ownerIsAuditor ? ' · must be auditors on an auditor series' : ''}
        </span>
      </div>
      {permissions?.manageEditors && (
        <div className="max-w-sm">
          <UserPicker
            key={`e-${pickerKey}`}
            mode="strict"
            placeholder="Add an editor — name or email…"
            autoFocus={false}
            openOnFocus={false}
            compact
            onSelect={(sel) => {
              if (sel.type === 'person' && sel.person.email) void addEditor(sel.person.email, sel.person.name);
            }}
          />
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Who follows the series — seen by everyone who can see the series. The
 * owner and editors add and remove followers; a follower may remove
 * themselves (§11.1). Followers get only the members the OWNER owns or
 * edits (an auditor series: every member) — §11.4. The server enforces all.
 */
export function SeriesFollowersSection({
  seriesId,
  followers,
  permissions,
  owner,
  viewerEmail,
  onChanged,
}: {
  seriesId: number;
  followers: SeriesFollowerView[];
  permissions: SeriesPermissionsView | null;
  owner?: SeriesOwnerView | null;
  viewerEmail: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const me = viewerEmail?.trim().toLowerCase() ?? null;

  const add = async (email: string, name: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await peopleCall(
        `/api/series/${seriesId}/followers`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name }) },
        "Couldn't add the follower"
      );
      setPickerKey((k) => k + 1);
      onChanged();
    } catch (err) {
      setError(networkErrorMessage(err, "Couldn't add the follower"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (email: string) => {
    const self = me === email;
    if (
      !confirm(
        self
          ? 'Stop following this series? Your read access to its meetings (the follow shares) is removed.'
          : `Remove ${email} as a follower? Their read access to this series' meetings (the follow shares) is removed.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await peopleCall(
        `/api/series/${seriesId}/followers?email=${encodeURIComponent(email)}`,
        { method: 'DELETE' },
        "Couldn't remove the follower"
      );
      onChanged();
    } catch (err) {
      setError(networkErrorMessage(err, "Couldn't remove the follower"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Followers
        </span>
        <span className="text-[11px] text-muted-foreground">
          {owner?.isAuditor
            ? 'read every meeting in the series (auditor series)'
            : `get the meetings ${firstName(owner)} owns or edits (auditors: every meeting in the series)`}
        </span>
      </div>
      {followers.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nobody follows this series.</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {followers.map((f) => (
            <PersonChip
              key={f.email}
              label={f.name || f.email}
              title={`${f.email} · added by ${f.added_by_email}`}
              busy={busy}
              onRemove={
                permissions?.manageFollowers || (!!me && me === f.email) ? () => void remove(f.email) : undefined
              }
              removeTitle={me === f.email ? 'Unfollow' : 'Remove follower'}
            />
          ))}
        </div>
      )}
      {permissions?.manageFollowers && (
        <div className="max-w-sm">
          <UserPicker
            key={pickerKey}
            mode="strict"
            placeholder="Add a follower — name or email…"
            autoFocus={false}
            openOnFocus={false}
            compact
            onSelect={(sel) => {
              if (sel.type === 'person' && sel.person.email) void add(sel.person.email, sel.person.name);
            }}
          />
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
