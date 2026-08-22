import { describe, expect, test } from 'bun:test';
import {
  classifyCalendarAttachments,
  classifyEvidence,
  classifyRecordings,
  classifyTranscripts,
} from '@/lib/meeting-evidence';

const doc = (title: string, fileId = 'd1') => ({
  fileId,
  title,
  mimeType: 'application/vnd.google-apps.document',
});

describe('classifyCalendarAttachments', () => {
  test('explicit transcript Doc wins over gemini', () => {
    const r = classifyCalendarAttachments([
      doc('Notes by Gemini', 'g'),
      doc('Weekly Sync - Transcript', 't'),
    ]);
    expect(r.transcriptDocId).toBe('t');
    expect(r.geminiNotes).toBe(false);
  });

  test('D7: "Transcript of X" counts (unanchored)', () => {
    const r = classifyCalendarAttachments([doc('Transcript of Weekly Sync', 't')]);
    expect(r.transcriptDocId).toBe('t');
  });

  test('D1: gemini-notes-only meeting yields a transcript doc', () => {
    const r = classifyCalendarAttachments([doc('Notes by Gemini', 'g')]);
    expect(r.transcriptDocId).toBe('g');
    expect(r.geminiNotes).toBe(true);
  });

  test('mixed-title Doc ("Gemini notes — Transcript") is the gemini doc', () => {
    const r = classifyCalendarAttachments([doc('Gemini notes — Transcript', 'g')]);
    expect(r.transcriptDocId).toBe('g');
    expect(r.geminiNotes).toBe(true);
  });

  test('agenda docs / file-less attachments ignored; videos counted', () => {
    const r = classifyCalendarAttachments([
      doc('Agenda', 'a'),
      { title: 'X - Transcript', mimeType: 'application/vnd.google-apps.document' },
      { fileId: 'v1', title: 'rec', mimeType: 'video/mp4' },
      { fileId: 'v2', title: 'rec2', mimeType: 'video/mp4' },
    ]);
    expect(r.transcriptDocId).toBeNull();
    expect(r.videoFileId).toBe('v1');
    expect(r.videoCount).toBe(2);
  });
});

describe('classifyRecordings', () => {
  test('D4: listed but never generated is NOT ready', () => {
    const r = classifyRecordings([{ fileId: null }]);
    expect(r.state).toBe('generating');
    expect(r.ready).toBe(0);
    expect(r.listed).toBe(1);
  });

  test('D11: one file ready + one generating = partial (still pending)', () => {
    const r = classifyRecordings([{ fileId: 'f1' }, { fileId: null }]);
    expect(r.state).toBe('partial');
    expect(r.ready).toBe(1);
    expect(classifyEvidence({ recording: r, transcript: classifyTranscripts({}) }).pending).toBe(
      true
    );
  });

  test('all files present = ready; empty list = none', () => {
    expect(classifyRecordings([{ fileId: 'f' }]).state).toBe('ready');
    expect(classifyRecordings([]).state).toBe('none');
    expect(classifyRecordings(undefined).state).toBe('none');
  });
});

describe('classifyTranscripts', () => {
  test('D2: session listed without a Doc = generating (not "none")', () => {
    const t = classifyTranscripts({ docIds: [], listed: 1 });
    expect(t.state).toBe('generating');
  });

  test('D8: doc with parseable=false = unparseable', () => {
    const t = classifyTranscripts({ docIds: ['d'], parseable: false });
    expect(t.state).toBe('unparseable');
  });

  test('attachment doc merges with API docs, gemini source flagged', () => {
    const att = classifyCalendarAttachments([doc('Notes by Gemini', 'g')]);
    const t = classifyTranscripts({ docIds: [], listed: 0, attachments: att });
    expect(t.state).toBe('ready');
    expect(t.docIds).toEqual(['g']);
    expect(t.source).toBe('gemini');
    const dup = classifyTranscripts({ docIds: ['g'], attachments: att });
    expect(dup.docIds).toEqual(['g']);
    expect(dup.source).toBe('meet');
  });
});

describe('classifyEvidence', () => {
  test('unparseable transcript alone is not importable', () => {
    const v = classifyEvidence({
      recording: classifyRecordings([]),
      transcript: classifyTranscripts({ docIds: ['d'], parseable: false }),
    });
    expect(v.hasTranscript).toBe(false);
    expect(v.importable).toBe(false);
  });

  test('generating transcript is importable (pending)', () => {
    const v = classifyEvidence({
      recording: classifyRecordings([]),
      transcript: classifyTranscripts({ listed: 1 }),
    });
    expect(v.pending).toBe(true);
    expect(v.importable).toBe(true);
    expect(v.hasTranscript).toBe(false);
  });
});
