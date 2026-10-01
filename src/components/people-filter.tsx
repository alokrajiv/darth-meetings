'use client';

/**
 * People / provider filter control for the meeting listing.
 *
 * Owns nothing server-side: it only edits a `PeopleFilters` value that the
 * listing turns into the shared `participant` / `organizer` / `provider`
 * query params (see src/lib/server/meeting-filters.ts for THE contract —
 * every listing layer accepts exactly those names, comma = OR, AND across
 * params; counts come back already filtered).
 *
 * State lives in the URL (?participant=&organizer=&provider=) so a filtered
 * view is a shareable link; `readPeopleFiltersFromUrl` / `writePeopleFiltersToUrl`
 * are the two sides of that sync and `appendPeopleFilterParams` is what
 * every fetch calls.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, X } from 'lucide-react';
import type { MeetingProvider } from '@/lib/server/meeting-filters';

export interface PeopleFilters {
  /** OR terms, already trimmed + de-duplicated (case preserved for display). */
  participant: string[];
  organizer: string[];
  provider: MeetingProvider[];
}

export const EMPTY_PEOPLE_FILTERS: PeopleFilters = {
  participant: [],
  organizer: [],
  provider: [],
};

const PROVIDER_OPTIONS: { key: MeetingProvider; label: string; title: string }[] = [
  { key: 'teams', label: 'Teams', title: 'Microsoft Teams meetings' },
  { key: 'gmeet', label: 'Meet', title: 'Google Meet meetings' },
  { key: 'upload', label: 'Upload', title: 'Uploaded files / text imports with no meeting identity' },
];
const PROVIDER_KEYS = PROVIDER_OPTIONS.map((p) => p.key);
const PROVIDER_LABEL: Record<MeetingProvider, string> = {
  teams: 'Teams',
  gmeet: 'Meet',
  upload: 'Upload',
};

/** Comma list → trimmed, de-duplicated (case-insensitive) terms. */
export function splitTerms(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function hasPeopleFilters(f: PeopleFilters): boolean {
  return f.participant.length > 0 || f.organizer.length > 0 || f.provider.length > 0;
}

export function countPeopleFilters(f: PeopleFilters): number {
  return f.participant.length + f.organizer.length + f.provider.length;
}

/** Stable identity key — handy as an effect dependency. */
export function peopleFiltersKey(f: PeopleFilters): string {
  return JSON.stringify([
    f.participant.map((s) => s.toLowerCase()),
    f.organizer.map((s) => s.toLowerCase()),
    f.provider,
  ]);
}

/** Set the shared query params on an outgoing listing request. */
export function appendPeopleFilterParams(params: URLSearchParams, f: PeopleFilters): void {
  if (f.participant.length) params.set('participant', f.participant.join(','));
  if (f.organizer.length) params.set('organizer', f.organizer.join(','));
  if (f.provider.length) params.set('provider', f.provider.join(','));
}

export function readPeopleFiltersFromUrl(search: string): PeopleFilters {
  const sp = new URLSearchParams(search);
  const read = (name: string) => splitTerms(sp.getAll(name).join(','));
  const provider = read('provider')
    .map((p) => p.toLowerCase())
    .filter((p): p is MeetingProvider => (PROVIDER_KEYS as string[]).includes(p));
  return {
    participant: read('participant'),
    organizer: read('organizer'),
    provider: Array.from(new Set(provider)),
  };
}

/** Rewrite the current URL's filter params in place (history.replaceState,
 * other params untouched). */
export function writePeopleFiltersToUrl(f: PeopleFilters): void {
  if (typeof window === 'undefined') return;
  const sp = new URLSearchParams(window.location.search);
  sp.delete('participant');
  sp.delete('organizer');
  sp.delete('provider');
  appendPeopleFilterParams(sp, f);
  const qs = sp.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== cur) window.history.replaceState(window.history.state, '', next);
}

interface PeopleFilterProps {
  value: PeopleFilters;
  onChange: (next: PeopleFilters) => void;
  /** Offline mode / network down: filters re-query the server, so the trigger and chips are inert. */
  disabled?: boolean;
}

const OFFLINE_TITLE = 'Not available offline';

/**
 * The People / Organizer inputs and the provider toggles — the "People"
 * section of the listing's ONE Filter popover. Text inputs are drafts
 * committed on Enter, blur, and when the popover closes (the section
 * unmounts without a blur, so the unmount commits) — typed text is never
 * silently discarded; provider toggles commit immediately. Active filters
 * render as removable chips via `PeopleFilterChips` (placed by the caller).
 */
export function PeopleFilterFields({ value, onChange, disabled = false }: PeopleFilterProps) {
  const [participantDraft, setParticipantDraft] = useState(value.participant.join(', '));
  const [organizerDraft, setOrganizerDraft] = useState(value.organizer.join(', '));

  // Drafts mirror the committed value whenever it changes from outside
  // (chip removal, URL load, Clear).
  useEffect(() => {
    setParticipantDraft(value.participant.join(', '));
  }, [value.participant]);
  useEffect(() => {
    setOrganizerDraft(value.organizer.join(', '));
  }, [value.organizer]);

  const commitText = () => {
    const participant = splitTerms(participantDraft);
    const organizer = splitTerms(organizerDraft);
    if (
      peopleFiltersKey({ ...value, participant, organizer }) !== peopleFiltersKey(value)
    ) {
      onChange({ ...value, participant, organizer });
    }
  };
  // The popover closing (outside click / Escape) unmounts the inputs before
  // they ever blur — commit the drafts on unmount through the latest fn.
  const commitRef = useRef(commitText);
  commitRef.current = commitText;
  useEffect(() => () => commitRef.current(), []);

  const toggleProvider = (key: MeetingProvider) => {
    const on = value.provider.includes(key);
    const provider = on
      ? value.provider.filter((p) => p !== key)
      : PROVIDER_KEYS.filter((p) => p === key || value.provider.includes(p));
    onChange({ ...value, provider });
  };

  return (
    <form
      className="space-y-2.5 px-1"
      data-people-filter
      onSubmit={(e) => {
        e.preventDefault();
        commitText();
      }}
    >
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">People</span>
        <Input
          value={participantDraft}
          onChange={(e) => setParticipantDraft(e.target.value)}
          onBlur={commitText}
          disabled={disabled}
          placeholder="email, name or @domain — comma = OR"
          className="h-8 text-sm"
          aria-label="People (email, name or domain; comma = OR)"
        />
        <span className="mt-1 block text-[10px] text-muted-foreground">
          Matches organizer, attendees and speakers. e.g. <code>@lp-global.com</code>,{' '}
          <code>nicolas</code>
        </span>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Organizer</span>
        <Input
          value={organizerDraft}
          onChange={(e) => setOrganizerDraft(e.target.value)}
          onBlur={commitText}
          disabled={disabled}
          placeholder="organizer email — comma = OR"
          className="h-8 text-sm"
          aria-label="Organizer email (comma = OR)"
        />
      </label>
      <div>
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Provider</span>
        <div className="flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5">
          {PROVIDER_OPTIONS.map((p) => {
            const on = value.provider.includes(p.key);
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => toggleProvider(p.key)}
                disabled={disabled}
                aria-pressed={on}
                title={p.title}
                className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                  on
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Check className={`h-3 w-3 ${on ? 'text-primary' : 'invisible'}`} aria-hidden />
                {p.label}
              </button>
            );
          })}
        </div>
        <span className="mt-1 block text-[10px] text-muted-foreground">None selected = any provider.</span>
      </div>
      {/* Enter in either input submits (commits); the button is for mice. */}
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={disabled}>
          Apply
        </Button>
      </div>
    </form>
  );
}

/** Removable chips for every active filter term. Renders nothing when no
 * filter is set. */
export function PeopleFilterChips({ value, onChange, disabled = false }: PeopleFilterProps) {
  if (!hasPeopleFilters(value)) return null;
  const chip = (key: string, label: string, text: string, onRemove: () => void) => (
    <span
      key={key}
      className="inline-flex max-w-[260px] items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2 pr-1 text-xs"
      title={`${label}: ${text}`}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{text}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        title={disabled ? OFFLINE_TITLE : undefined}
        className="rounded-full p-0.5 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={`Remove filter ${label} ${text}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="people-filter-chips">
      {value.participant.map((t) =>
        chip(`p:${t}`, 'People', t, () =>
          onChange({ ...value, participant: value.participant.filter((x) => x !== t) })
        )
      )}
      {value.organizer.map((t) =>
        chip(`o:${t}`, 'Organizer', t, () =>
          onChange({ ...value, organizer: value.organizer.filter((x) => x !== t) })
        )
      )}
      {value.provider.map((p) =>
        chip(`v:${p}`, 'Provider', PROVIDER_LABEL[p], () =>
          onChange({ ...value, provider: value.provider.filter((x) => x !== p) })
        )
      )}
      {countPeopleFilters(value) > 1 && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_PEOPLE_FILTERS)}
          disabled={disabled}
          title={disabled ? OFFLINE_TITLE : undefined}
          className="text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
