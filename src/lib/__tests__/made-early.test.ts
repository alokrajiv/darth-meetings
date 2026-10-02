import { describe, expect, test } from 'bun:test';
import { borrowedMediaReason, madeEarlyAwaitingText, madeFromRecordingId } from '@/lib/made-early';

const RID = '02af969f-ee5e-4c82-879f-5d971e568e6c';
const fromRecording = { fromRecording: { recordingId: RID } };

describe('madeEarlyAwaitingText — whose business a textless made-early meeting is', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    status: 'processing',
    aai_job_id: null,
    deleted_at: null,
    imported_content: null,
    gmeet_context: fromRecording,
    ...over,
  });

  test('processing, or an error something left behind (prod 2026-10-02) — both ask the recording', () => {
    expect(madeEarlyAwaitingText(row())).toBe(true);
    expect(madeEarlyAwaitingText(row({ status: 'error' }))).toBe(true);
  });

  test('not once it has text, a job of its own, or is trashed', () => {
    expect(madeEarlyAwaitingText(row({ imported_content: { utterances: [] } }))).toBe(false);
    expect(madeEarlyAwaitingText(row({ aai_job_id: 'job-1' }))).toBe(false);
    expect(madeEarlyAwaitingText(row({ deleted_at: '2026-10-02T00:00:00Z' }))).toBe(false);
    expect(madeEarlyAwaitingText(row({ status: 'completed' }))).toBe(false);
  });

  test('not an ordinary meeting', () => {
    expect(madeEarlyAwaitingText(row({ gmeet_context: null }))).toBe(false);
    expect(madeEarlyAwaitingText(row({ gmeet_context: { clips: [] } }))).toBe(false);
  });
});

describe('borrowedMediaReason — rows whose file must never be re-ingested', () => {
  test('made from a recording / split off a meeting', () => {
    expect(madeFromRecordingId({ gmeet_context: fromRecording })).toBe(RID);
    expect(borrowedMediaReason({ gmeet_context: fromRecording })).toBe('made-from-recording');
    expect(borrowedMediaReason({ gmeet_context: { splitFrom: { assemblyaiId: 'x' } } })).toBe('split');
  });

  test('an ordinary kept-failure upload owns its file', () => {
    expect(borrowedMediaReason({ gmeet_context: null })).toBeNull();
    expect(borrowedMediaReason({ gmeet_context: { clips: [] } })).toBeNull();
    expect(madeFromRecordingId({ gmeet_context: { fromRecording: null } })).toBeNull();
  });
});
