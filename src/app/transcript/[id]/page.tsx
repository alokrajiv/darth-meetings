'use client';

import { useState, useEffect, useCallback, useMemo, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  formatDuration,
  formatTime,
  type StoredTranscript,
  type TranscriptResponse,
  type SpeakerLabel,
  type TranscriptEditMap,
  type TranscriptAccess,
  type TranscriptShare,
} from '@/lib/format';
import { AudioPlayer, type AudioPlayerHandle } from '@/components/audio-player';
import { EditableUtterance, type UtteranceHighlight } from '@/components/editable-utterance';
import { FindReplacePanel } from '@/components/find-replace-panel';
import { SpeakerSummaryPanel } from '@/components/speaker-summary-panel';
import { ShareDialog } from '@/components/share-dialog';
import { AddPersonDialog } from '@/components/add-person-dialog';
import type { PickerPerson } from '@/components/user-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { defaultSpeakerLabel } from '@/lib/speaker-display';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  RefreshCw,
  Download,
  Copy,
  Edit,
  Save,
  X,
  Search,
  Eye,
  Pencil,
  Users,
} from 'lucide-react';

/**
 * Find the index of the utterance whose [start, end) interval contains the
 * given timestamp (milliseconds). Returns -1 if none. Linear scan — fine for
 * a few thousand utterances.
 */
function findUtteranceIndexAtMs(
  utterances: TranscriptResponse['utterances'],
  ms: number
): number {
  if (!utterances) return -1;
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i]!;
    if (ms >= u.start && ms < u.end) return i;
    if (ms < u.start) return -1;
  }
  return -1;
}

type ViewMode = 'raw' | 'edited';

interface TranscriptDetailPageProps {
  params: Promise<{ id: string }>;
}

export default function TranscriptDetailPage({ params }: TranscriptDetailPageProps) {
  const router = useRouter();
  const { id: transcriptId } = use(params);

  const [row, setRow] = useState<StoredTranscript | null>(null);
  const [access, setAccess] = useState<TranscriptAccess>('owner');
  const [shareOpen, setShareOpen] = useState(false);
  const [collaboratorEmails, setCollaboratorEmails] = useState<Set<string>>(
    () => new Set()
  );
  const [pendingShare, setPendingShare] = useState<PickerPerson | null>(null);
  const [sharingPending, setSharingPending] = useState(false);
  const [sharingError, setSharingError] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{
    originalSpeaker: string;
    name: string;
  } | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [content, setContent] = useState<TranscriptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canEdit = access === 'owner' || access === 'edit';
  const isOwner = access === 'owner';

  const [speakerLabels, setSpeakerLabels] = useState<SpeakerLabel[]>([]);
  const [transcriptEdits, setTranscriptEdits] = useState<TranscriptEditMap>({});

  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);

  // --- audio player state ---
  const playerRef = useRef<AudioPlayerHandle>(null);
  const [currentTime, setCurrentTime] = useState(0); // seconds, from <audio>
  const [audioAvailable, setAudioAvailable] = useState(true);

  // --- view mode + find/replace ---
  const [viewMode, setViewMode] = useState<ViewMode>('edited');
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [currentMatchPos, setCurrentMatchPos] = useState(0); // 0-based

  // --- derived helpers ---

  const currentUtteranceIndex = useMemo(
    () => findUtteranceIndexAtMs(content?.utterances, currentTime * 1000),
    [content?.utterances, currentTime]
  );

  /**
   * Resolve a raw speaker key into the display name, applying speaker_mappings.
   * In raw view we deliberately bypass mappings to show the original AAI labels.
   */
  const speakerDisplayName = useCallback(
    (originalSpeaker: string): string => {
      if (viewMode === 'raw') return defaultSpeakerLabel(originalSpeaker);
      const mapping = speakerLabels.find((m) => m.originalSpeaker === originalSpeaker);
      return mapping?.customName || defaultSpeakerLabel(originalSpeaker);
    },
    [speakerLabels, viewMode]
  );

  /**
   * Compose the display text for one utterance — raw text or with the user's
   * per-utterance text override applied. In raw mode, edits are ignored.
   */
  const displayTextFor = useCallback(
    (index: number): string => {
      const raw = content?.utterances?.[index]?.text ?? '';
      if (viewMode === 'raw') return raw;
      const edit = transcriptEdits[String(index)];
      return edit?.text ?? raw;
    },
    [content?.utterances, transcriptEdits, viewMode]
  );

  const isTextEdited = useCallback(
    (index: number): boolean => {
      const raw = content?.utterances?.[index]?.text ?? '';
      const edit = transcriptEdits[String(index)];
      return edit?.text !== undefined && edit.text !== raw;
    },
    [content?.utterances, transcriptEdits]
  );

  // --- network actions ---

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [rowRes, speakersRes, editsRes, sharesRes] = await Promise.all([
        fetch(`/api/transcripts/${transcriptId}`),
        fetch(`/api/transcripts/${transcriptId}/speakers`),
        fetch(`/api/transcripts/${transcriptId}/edits`),
        fetch(`/api/transcripts/${transcriptId}/shares`),
      ]);

      if (rowRes.status === 404) {
        setError('Transcript not found');
        return;
      }
      if (!rowRes.ok) {
        throw new Error(`Failed to load transcript (${rowRes.status})`);
      }
      const { transcript } = (await rowRes.json()) as {
        transcript: StoredTranscript & { access?: TranscriptAccess };
      };
      setRow(transcript);
      setAccess(transcript.access ?? 'owner');
      setTitle(transcript.title || '');
      setDescription(transcript.description || '');

      if (speakersRes.ok) {
        const { speakerLabels: labels } = (await speakersRes.json()) as {
          speakerLabels: SpeakerLabel[];
        };
        setSpeakerLabels(labels);
      }

      if (editsRes.ok) {
        const { edits } = (await editsRes.json()) as { edits: TranscriptEditMap };
        setTranscriptEdits(edits ?? {});
      }

      if (sharesRes.ok) {
        const { shares } = (await sharesRes.json()) as { shares: TranscriptShare[] };
        setCollaboratorEmails(
          new Set(shares.map((s) => s.shared_with_email.toLowerCase()))
        );
      }

      if (transcript.status === 'completed') {
        const contentRes = await fetch(`/api/transcripts/${transcriptId}/content`);
        if (contentRes.ok) {
          const { content } = (await contentRes.json()) as { content: TranscriptResponse };
          setContent(content);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transcript');
    } finally {
      setLoading(false);
    }
  }, [transcriptId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Grab the current user's email once so the speaker-pick "add to access?"
  // prompt can suppress itself when the owner picks themselves from the
  // picker. Cheap fetch; fire-and-forget.
  useEffect(() => {
    fetch('/api/auth/session', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.email) setCurrentUserEmail(String(data.email).toLowerCase());
      })
      .catch(() => {});
  }, []);

  // ⌘F / Ctrl+F → toggle find-and-replace panel
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        // Only intercept when no input is focused, so the browser's native
        // ⌘F still works in form fields.
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        e.preventDefault();
        setFindReplaceOpen((v) => !v);
      } else if (e.key === 'Escape' && findReplaceOpen) {
        setFindReplaceOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findReplaceOpen]);

  // --- click handlers ---

  const handleSeekToUtterance = useCallback(
    (idx: number) => {
      const u = content?.utterances?.[idx];
      if (!u) return;
      playerRef.current?.seekToSeconds(u.start / 1000);
    },
    [content?.utterances]
  );

  const handleSaveText = useCallback(
    async (index: number, newText: string) => {
      const raw = content?.utterances?.[index]?.text ?? '';
      // Optimistic local update
      setTranscriptEdits((prev) => {
        const next = { ...prev };
        const key = String(index);
        if (newText === raw) {
          // Edit reverts to raw → drop the override entirely
          if (next[key]) {
            const { text: _omit, ...rest } = next[key]!;
            if (rest.speaker !== undefined) next[key] = rest;
            else delete next[key];
          }
        } else {
          next[key] = { ...(next[key] ?? {}), text: newText };
        }
        return next;
      });

      try {
        // If reverting to raw, we still send a PATCH so the server-side override
        // is cleared. PATCH supports text='' as a valid edit, so to express
        // "remove the override" we instead send the new text — even if it equals
        // raw — and rely on patchUtteranceForUser to keep them in sync. The map
        // we read back next time will reflect whatever the server has.
        const res = await fetch(`/api/transcripts/${transcriptId}/edits`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ utteranceIndex: index, text: newText }),
        });
        if (!res.ok) throw new Error(`PATCH failed (${res.status})`);
        const { edits } = (await res.json()) as { edits: TranscriptEditMap };
        setTranscriptEdits(edits ?? {});
      } catch (err) {
        console.error('Failed to save utterance edit:', err);
        alert('Failed to save edit. Reloading from server.');
        loadAll();
      }
    },
    [content?.utterances, transcriptId, loadAll]
  );

  /**
   * Save a partial update for one speaker (name and/or description). Merges
   * with the existing entry, optimistically updates local state, and PUTs the
   * full label set.
   */
  const handleSaveSpeaker = useCallback(
    async (
      originalSpeaker: string,
      patch: { customName?: string; description?: string }
    ) => {
      const existing = speakerLabels.find((m) => m.originalSpeaker === originalSpeaker);
      const merged: SpeakerLabel = {
        originalSpeaker,
        customName: patch.customName ?? existing?.customName ?? '',
        description: patch.description ?? existing?.description ?? '',
      };
      const without = speakerLabels.filter((m) => m.originalSpeaker !== originalSpeaker);
      const next = [...without, merged];

      // Optimistic local update
      setSpeakerLabels(next);

      try {
        const res = await fetch(`/api/transcripts/${transcriptId}/speakers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speakerLabels: next }),
        });
        if (!res.ok) throw new Error(`PUT speakers failed (${res.status})`);
        const { speakerLabels: saved } = (await res.json()) as { speakerLabels: SpeakerLabel[] };
        setSpeakerLabels(saved);
      } catch (err) {
        console.error('Failed to save speaker:', err);
        alert('Failed to save speaker. Reloading from server.');
        loadAll();
      }
    },
    [speakerLabels, transcriptId, loadAll]
  );

  // --- find & replace: matches list, derived live from query + content + edits ---

  interface FindMatch {
    utteranceIndex: number;
    start: number;
    end: number;
  }

  const findMatches = useMemo<FindMatch[]>(() => {
    if (!findQuery || !content?.utterances || viewMode === 'raw') return [];
    const out: FindMatch[] = [];
    const needleLen = findQuery.length;
    if (needleLen === 0) return out;
    const cmpQuery = findCaseSensitive ? findQuery : findQuery.toLowerCase();

    for (let i = 0; i < content.utterances.length; i++) {
      const raw = content.utterances[i]!.text;
      const text = transcriptEdits[String(i)]?.text ?? raw;
      const haystack = findCaseSensitive ? text : text.toLowerCase();
      let from = 0;
      while (from <= haystack.length - needleLen) {
        const idx = haystack.indexOf(cmpQuery, from);
        if (idx === -1) break;
        out.push({ utteranceIndex: i, start: idx, end: idx + needleLen });
        from = idx + needleLen;
      }
    }
    return out;
  }, [findQuery, findCaseSensitive, content?.utterances, transcriptEdits, viewMode]);

  // Whenever the matches list shrinks past the cursor, clamp.
  useEffect(() => {
    if (currentMatchPos >= findMatches.length) {
      setCurrentMatchPos(0);
    }
  }, [findMatches.length, currentMatchPos]);

  // Scroll the focused match into view when it changes.
  useEffect(() => {
    if (findMatches.length === 0) return;
    const m = findMatches[currentMatchPos];
    if (!m) return;
    const el = document.querySelector<HTMLElement>(
      `[data-utterance-index="${m.utteranceIndex}"]`
    );
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [findMatches, currentMatchPos]);

  /** Build per-utterance highlight ranges for the EditableUtterance components. */
  const highlightsByUtterance = useMemo<Map<number, UtteranceHighlight[]>>(() => {
    const map = new Map<number, UtteranceHighlight[]>();
    findMatches.forEach((m, idx) => {
      const arr = map.get(m.utteranceIndex) ?? [];
      arr.push({
        start: m.start,
        end: m.end,
        isCurrent: idx === currentMatchPos,
      });
      map.set(m.utteranceIndex, arr);
    });
    return map;
  }, [findMatches, currentMatchPos]);

  const handleFindNext = useCallback(() => {
    if (findMatches.length === 0) return;
    setCurrentMatchPos((p) => (p + 1) % findMatches.length);
  }, [findMatches.length]);

  const handleFindPrev = useCallback(() => {
    if (findMatches.length === 0) return;
    setCurrentMatchPos((p) => (p - 1 + findMatches.length) % findMatches.length);
  }, [findMatches.length]);

  /**
   * Replace the *current* focused match. After saving, the matches list
   * is recomputed and the cursor stays put — which usually puts you on the
   * next match because the current one is gone.
   */
  const handleReplaceCurrent = useCallback(async () => {
    if (findMatches.length === 0 || !content?.utterances) return;
    const m = findMatches[currentMatchPos];
    if (!m) return;
    const i = m.utteranceIndex;
    const raw = content.utterances[i]!.text;
    const currentText = transcriptEdits[String(i)]?.text ?? raw;
    const newText =
      currentText.substring(0, m.start) + replaceWith + currentText.substring(m.end);

    const nextEdits: TranscriptEditMap = { ...transcriptEdits };
    const key = String(i);
    if (newText === raw) {
      if (nextEdits[key]) {
        const { text: _omit, ...rest } = nextEdits[key]!;
        if (rest.speaker !== undefined) nextEdits[key] = rest;
        else delete nextEdits[key];
      }
    } else {
      nextEdits[key] = { ...(nextEdits[key] ?? {}), text: newText };
    }
    setTranscriptEdits(nextEdits);

    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/edits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utteranceIndex: i, text: newText }),
      });
      if (!res.ok) throw new Error(`PATCH failed (${res.status})`);
      const { edits } = (await res.json()) as { edits: TranscriptEditMap };
      setTranscriptEdits(edits ?? {});
    } catch (err) {
      console.error('Failed to replace current:', err);
      alert('Failed to save replacement. Reloading from server.');
      loadAll();
    }
  }, [
    findMatches,
    currentMatchPos,
    content?.utterances,
    transcriptEdits,
    replaceWith,
    transcriptId,
    loadAll,
  ]);

  /**
   * Replace every match in one shot. Computes the new edit map locally and
   * PUTs it in a single request. Builds replacements right-to-left within
   * each utterance so positions stay valid.
   */
  const handleReplaceAll = useCallback(async () => {
    if (findMatches.length === 0 || !content?.utterances) return;

    const nextEdits: TranscriptEditMap = { ...transcriptEdits };
    const groupedByUtterance = new Map<number, FindMatch[]>();
    for (const m of findMatches) {
      const arr = groupedByUtterance.get(m.utteranceIndex) ?? [];
      arr.push(m);
      groupedByUtterance.set(m.utteranceIndex, arr);
    }

    for (const [i, matches] of groupedByUtterance) {
      const raw = content.utterances[i]!.text;
      let text = transcriptEdits[String(i)]?.text ?? raw;
      // Right-to-left so each splice doesn't shift later positions.
      const sorted = [...matches].sort((a, b) => b.start - a.start);
      for (const m of sorted) {
        text = text.substring(0, m.start) + replaceWith + text.substring(m.end);
      }
      const key = String(i);
      if (text === raw) {
        if (nextEdits[key]) {
          const { text: _omit, ...rest } = nextEdits[key]!;
          if (rest.speaker !== undefined) nextEdits[key] = rest;
          else delete nextEdits[key];
        }
      } else {
        nextEdits[key] = { ...(nextEdits[key] ?? {}), text };
      }
    }

    setTranscriptEdits(nextEdits);

    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/edits`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: nextEdits }),
      });
      if (!res.ok) throw new Error(`PUT failed (${res.status})`);
      const { edits } = (await res.json()) as { edits: TranscriptEditMap };
      setTranscriptEdits(edits ?? {});
    } catch (err) {
      console.error('Failed to replace all:', err);
      alert('Failed to save replacements. Reloading from server.');
      loadAll();
    }
  }, [findMatches, content?.utterances, transcriptEdits, replaceWith, transcriptId, loadAll]);

  // --- speaker-pick → add-to-access prompt (shared by summary panel + badge editor) ---

  const handlePickPerson = useCallback(
    (person: PickerPerson) => {
      if (!isOwner) return;
      if (!person.email) return;
      const picked = person.email.toLowerCase();
      // Don't prompt for yourself — you already own the transcript.
      if (currentUserEmail && picked === currentUserEmail) return;
      // Don't prompt for people who are already collaborators.
      if (collaboratorEmails.has(picked)) return;
      setPendingShare(person);
      setSharingError(null);
    },
    [isOwner, collaboratorEmails, currentUserEmail]
  );

  const handleRequestCreatePerson = useCallback(
    (originalSpeaker: string, name: string) => {
      setPendingCreate({ originalSpeaker, name });
    },
    []
  );

  const handlePersonCreated = useCallback(
    (person: PickerPerson) => {
      if (!pendingCreate) return;
      const original = pendingCreate.originalSpeaker;
      setPendingCreate(null);
      handleSaveSpeaker(original, { customName: person.name });
      handlePickPerson(person);
    },
    // handleSaveSpeaker and handlePickPerson are declared later — ref via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingCreate]
  );

  const handleUsePersonAsLabel = useCallback(
    (name: string) => {
      if (!pendingCreate) return;
      const original = pendingCreate.originalSpeaker;
      setPendingCreate(null);
      handleSaveSpeaker(original, { customName: name });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingCreate]
  );

  const handleConfirmPendingShare = async () => {
    if (!pendingShare || !pendingShare.email) return;
    try {
      setSharingPending(true);
      setSharingError(null);
      const res = await fetch(`/api/transcripts/${transcriptId}/shares`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: pendingShare.email,
          name: pendingShare.name,
          pplId: pendingShare.id,
          access: 'edit',
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed (${res.status})`);
      }
      setCollaboratorEmails((prev) => {
        const next = new Set(prev);
        next.add(pendingShare.email!.toLowerCase());
        return next;
      });
      setPendingShare(null);
    } catch (err) {
      setSharingError(err instanceof Error ? err.message : 'Failed to share');
    } finally {
      setSharingPending(false);
    }
  };

  // --- meta save (unchanged from before) ---

  const handleSaveMeta = async () => {
    try {
      setSavingMeta(true);
      const res = await fetch(`/api/transcripts/${transcriptId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      if (!res.ok) throw new Error(`PATCH failed (${res.status})`);
      const { transcript } = (await res.json()) as { transcript: StoredTranscript };
      setRow(transcript);
      setIsEditingMeta(false);
    } catch (err) {
      console.error('Error saving metadata:', err);
      alert('Failed to save title and description. Please try again.');
    } finally {
      setSavingMeta(false);
    }
  };

  const handleCancelEditMeta = () => {
    setTitle(row?.title || '');
    setDescription(row?.description || '');
    setIsEditingMeta(false);
  };

  // --- formatters / markdown ---

  const safeFormatDate = (value: string | null): string => {
    if (!value) return 'Unknown date';
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return 'Unknown date';
      return formatDistanceToNow(date, { addSuffix: true });
    } catch {
      return 'Unknown date';
    }
  };

  const formatFullDate = (value: string | null): string => {
    if (!value) return 'Unknown date';
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return 'Unknown date';
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return 'Unknown date';
    }
  };

  /**
   * Generate markdown from the transcript. `mode` controls whether we use raw
   * AAI content as-is or the composed edited view (text edits + speaker
   * mappings).
   */
  const generateMarkdown = (mode: ViewMode): string => {
    if (!row) return '';
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0]?.substring(0, 5) || '00:00';

    let markdown = `# ${title || 'Meeting Transcript'}\n\n`;
    if (description) markdown += `${description}\n\n`;
    markdown += `*Transcript ID: ${row.assemblyai_id}*\n`;
    markdown += `*Duration: ${row.duration ? formatDuration(row.duration) : 'N/A'}*\n`;
    markdown += `*Created: ${formatFullDate(row.created_at)}*\n`;
    markdown += `*Downloaded: ${dateStr} at ${timeStr} (${mode})*\n\n`;

    if (content?.utterances && content.utterances.length > 0) {
      const resolveSpeaker = (raw: string): string => {
        if (mode === 'raw') return defaultSpeakerLabel(raw);
        const m = speakerLabels.find((s) => s.originalSpeaker === raw);
        return m?.customName || defaultSpeakerLabel(raw);
      };
      const resolveDescription = (raw: string): string => {
        if (mode === 'raw') return '';
        const m = speakerLabels.find((s) => s.originalSpeaker === raw);
        return m?.description || '';
      };
      const resolveText = (idx: number, raw: string): string => {
        if (mode === 'raw') return raw;
        return transcriptEdits[String(idx)]?.text ?? raw;
      };

      markdown += `## Speakers\n`;
      const speakers = Array.from(new Set(content.utterances.map((u) => u.speaker))).sort();
      speakers.forEach((speaker) => {
        const displayName = resolveSpeaker(speaker);
        const defaultName = defaultSpeakerLabel(speaker);
        const namePart = displayName !== defaultName ? `**${displayName}** (${defaultName})` : `**${defaultName}**`;
        const description = resolveDescription(speaker);
        const descPart = description ? ` — ${description}` : '';
        markdown += `- ${namePart}${descPart}\n`;
      });

      markdown += `\n## Transcript\n\n`;
      content.utterances.forEach((utterance, idx) => {
        const ts = formatTime(utterance.start);
        const speakerName = resolveSpeaker(utterance.speaker);
        const text = resolveText(idx, utterance.text);
        markdown += `[${ts}] **${speakerName}**: ${text}\n\n`;
      });
    } else if (content?.text) {
      markdown += `## Transcript\n\n${content.text}\n\n`;
    }

    return markdown;
  };

  const downloadMarkdown = (mode: ViewMode) => {
    if (!row) return;
    const markdown = generateMarkdown(mode);
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${row.assemblyai_id}-${mode}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /**
   * Copy the edited markdown to the clipboard. Falls back to a hidden
   * textarea + execCommand('copy') path if the Async Clipboard API is
   * unavailable (e.g. served over plain HTTP or in older browsers).
   */
  const copyMarkdown = async () => {
    if (!row) return;
    const markdown = generateMarkdown('edited');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
      } else {
        const ta = document.createElement('textarea');
        ta.value = markdown;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-10000px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 1500);
    } catch (err) {
      console.error('copy failed', err);
      alert('Could not copy to clipboard');
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge variant="default" className="bg-green-100 text-green-800">Completed</Badge>;
      case 'processing':
        return <Badge variant="secondary">Processing</Badge>;
      case 'queued':
        return <Badge variant="outline">Queued</Badge>;
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  // --- early returns ---

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Loading Transcript...</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Error Loading Transcript</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-red-500 mb-4">{error}</p>
            <div className="flex gap-2">
              <Button onClick={loadAll} variant="outline">
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
              <Button onClick={() => router.push('/')} variant="outline">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to List
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!row) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Transcript Not Found</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">
              The transcript you&apos;re looking for doesn&apos;t exist or couldn&apos;t be loaded.
            </p>
            <Button onClick={() => router.push('/')} variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to List
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-start mb-6 gap-4">
        <div>
          <Button variant="outline" onClick={() => router.push('/')} className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Transcripts
          </Button>
          <h1 className="text-3xl font-bold">Transcript Details</h1>
          <p className="text-muted-foreground">ID: {row.assemblyai_id}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {access !== 'owner' && (
            <Badge variant="outline" className="text-[10px]">
              Shared — {access === 'edit' ? 'Editor' : 'Read-only'}
            </Badge>
          )}
          {/* Raw / Edited toggle */}
          <div className="inline-flex rounded-md border bg-background p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('raw')}
              className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs ${
                viewMode === 'raw' ? 'bg-muted font-medium' : 'text-muted-foreground'
              }`}
              title="Show original AAI output, ignoring all edits"
            >
              <Eye className="h-3 w-3" />
              Raw
            </button>
            <button
              type="button"
              onClick={() => setViewMode('edited')}
              className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs ${
                viewMode === 'edited' ? 'bg-muted font-medium' : 'text-muted-foreground'
              }`}
              title="Show edited view with text edits and speaker renames"
            >
              <Pencil className="h-3 w-3" />
              Edited
            </button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShareOpen(true)}
            title="Share access with other people"
          >
            <Users className="h-4 w-4 mr-1" />
            Access
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFindReplaceOpen((v) => !v)}
            disabled={!content || !canEdit}
            title={canEdit ? 'Find and replace (⌘F)' : 'Read-only access'}
          >
            <Search className="h-4 w-4 mr-1" />
            Find &amp; replace
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={copyMarkdown}
            disabled={!content}
            title="Copy edited markdown to clipboard"
          >
            <Copy className="h-4 w-4 mr-1" />
            {copyStatus === 'copied' ? 'Copied!' : 'Copy markdown'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadMarkdown('edited')}
            disabled={!content}
          >
            <Download className="h-4 w-4 mr-1" />
            Download edited
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadMarkdown('raw')}
            disabled={!content}
          >
            <Download className="h-4 w-4 mr-1" />
            Download raw
          </Button>
          <Button onClick={loadAll} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-6">
        {/* Audio player — sticky so it stays visible while scrolling the transcript */}
        {row.status === 'completed' && audioAvailable && (
          <div className="sticky top-2 z-10 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur">
            <AudioPlayer
              ref={playerRef}
              src={`/api/transcripts/${row.assemblyai_id}/audio`}
              onTimeUpdate={setCurrentTime}
              onError={() => setAudioAvailable(false)}
            />
          </div>
        )}

        {/* Title and Description */}
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>Title &amp; Description</CardTitle>
              {!isEditingMeta ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditingMeta(true)}
                  disabled={!canEdit}
                  title={canEdit ? 'Edit title and description' : 'Read-only access'}
                >
                  <Edit className="h-4 w-4 mr-2" />
                  Edit
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelEditMeta}
                    disabled={savingMeta}
                  >
                    <X className="h-4 w-4 mr-2" />
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleSaveMeta} disabled={savingMeta}>
                    <Save className="h-4 w-4 mr-2" />
                    {savingMeta ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {isEditingMeta ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    placeholder="Enter a title for this transcript"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    placeholder="Enter a description (optional)"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {title ? (
                  <div>
                    <p className="text-sm text-muted-foreground">Title</p>
                    <h3 className="text-lg font-medium">{title}</h3>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">No title set</p>
                )}
                {description && (
                  <div>
                    <p className="text-sm text-muted-foreground">Description</p>
                    <div className="markdown-body text-sm">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          h1: ({ children }) => <h1 className="text-xl font-semibold mt-3 mb-2">{children}</h1>,
                          h2: ({ children }) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
                          h3: ({ children }) => <h3 className="text-base font-semibold mt-3 mb-1.5">{children}</h3>,
                          p: ({ children }) => <p className="leading-relaxed my-2">{children}</p>,
                          ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
                          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline hover:text-blue-800">
                              {children}
                            </a>
                          ),
                          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                          em: ({ children }) => <em className="italic">{children}</em>,
                          code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
                          pre: ({ children }) => <pre className="rounded-md bg-muted p-3 overflow-x-auto my-2 text-xs font-mono">{children}</pre>,
                          blockquote: ({ children }) => (
                            <blockquote className="border-l-4 border-muted pl-3 italic text-muted-foreground my-2">{children}</blockquote>
                          ),
                          hr: () => <hr className="my-3 border-muted" />,
                          table: ({ children }) => (
                            <div className="overflow-x-auto my-2">
                              <table className="min-w-full border-collapse text-xs">{children}</table>
                            </div>
                          ),
                          th: ({ children }) => <th className="border px-2 py-1 bg-muted text-left">{children}</th>,
                          td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
                        }}
                      >
                        {description}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
                {!title && !description && (
                  <p className="text-muted-foreground text-sm">
                    Click Edit to add a title and description for this transcript.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Transcript Info */}
        <Card>
          <CardHeader>
            <CardTitle>Transcript Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <div className="mt-1">{getStatusBadge(row.status)}</div>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Created</p>
                <p className="mt-1">{safeFormatDate(row.created_at)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Duration</p>
                <p className="mt-1">{row.duration ? formatDuration(row.duration) : 'N/A'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Speakers</p>
                <p className="mt-1">{row.speaker_count ?? 'N/A'}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Speakers — friendly name + description per speaker */}
        {viewMode === 'edited' && content?.utterances && content.utterances.length > 0 && (
          <SpeakerSummaryPanel
            utterances={content.utterances}
            speakerLabels={speakerLabels}
            onSave={handleSaveSpeaker}
            canEdit={canEdit}
            onPickPerson={handlePickPerson}
            onRequestCreatePerson={handleRequestCreatePerson}
          />
        )}

        {/* Transcript Content */}
        <Card>
          <CardHeader>
            <CardTitle>
              Transcript{' '}
              <span className="text-xs font-normal text-muted-foreground">
                ({viewMode === 'edited' ? 'edited view' : 'raw — read only'})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {row.status === 'completed' && content ? (
              <div className="space-y-2">
                {content.utterances && content.utterances.length > 0 ? (
                  content.utterances.map((utterance, index) => (
                    <EditableUtterance
                      key={index}
                      index={index}
                      utterance={utterance}
                      displayText={displayTextFor(index)}
                      isTextEdited={viewMode === 'edited' && isTextEdited(index)}
                      isActive={index === currentUtteranceIndex}
                      speakerLabels={speakerLabels}
                      highlights={highlightsByUtterance.get(index)}
                      onSeek={handleSeekToUtterance}
                      canEdit={viewMode === 'edited' && canEdit}
                      onPickPerson={handlePickPerson}
                      onRequestCreatePerson={handleRequestCreatePerson}
                      onSaveText={
                        viewMode === 'edited' && canEdit
                          ? handleSaveText
                          : () => {
                              /* read-only */
                            }
                      }
                      onSaveSpeaker={
                        viewMode === 'edited' && canEdit
                          ? handleSaveSpeaker
                          : () => {
                              /* read-only */
                            }
                      }
                    />
                  ))
                ) : (
                  <p className="text-muted-foreground">
                    {content.text || 'No transcript content available'}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">
                Transcript is {row.status}. Content will be available when processing is complete.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        transcriptId={transcriptId}
        callerAccess={access}
        onSharesChanged={(shares) =>
          setCollaboratorEmails(
            new Set(shares.map((s) => s.shared_with_email.toLowerCase()))
          )
        }
      />

      <AddPersonDialog
        open={!!pendingCreate}
        initialName={pendingCreate?.name ?? ''}
        onCreated={handlePersonCreated}
        onUseAsLabel={handleUsePersonAsLabel}
        onCancel={() => setPendingCreate(null)}
      />

      <Dialog open={!!pendingShare} onOpenChange={(v) => !v && setPendingShare(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add to access?</DialogTitle>
            <DialogDescription>
              {pendingShare && (
                <>
                  You tagged <span className="font-medium">{pendingShare.name}</span>{' '}
                  as a speaker. Would you like to give them editor access to this
                  transcript so they can make corrections?
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {pendingShare?.email && (
            <div className="rounded-md border p-3 text-sm">
              <div className="font-medium">{pendingShare.name}</div>
              <div className="text-xs text-muted-foreground">{pendingShare.email}</div>
            </div>
          )}
          {sharingError && <p className="text-xs text-red-600">{sharingError}</p>}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setPendingShare(null)}
              disabled={sharingPending}
            >
              Skip
            </Button>
            <Button onClick={handleConfirmPendingShare} disabled={sharingPending}>
              {sharingPending ? 'Adding…' : 'Add as editor'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FindReplacePanel
        open={findReplaceOpen}
        onClose={() => setFindReplaceOpen(false)}
        query={findQuery}
        onQueryChange={(q) => {
          setFindQuery(q);
          setCurrentMatchPos(0);
        }}
        replace={replaceWith}
        onReplaceChange={setReplaceWith}
        caseSensitive={findCaseSensitive}
        onCaseSensitiveChange={(cs) => {
          setFindCaseSensitive(cs);
          setCurrentMatchPos(0);
        }}
        matchCount={findMatches.length}
        currentIndex={findMatches.length > 0 ? currentMatchPos + 1 : 0}
        onNext={handleFindNext}
        onPrev={handleFindPrev}
        onReplaceCurrent={handleReplaceCurrent}
        onReplaceAll={handleReplaceAll}
      />
    </div>
  );
}
