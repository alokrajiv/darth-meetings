import { beforeEach, describe, expect, mock, test } from 'bun:test';

// `mock.module` is process-wide — every dependency the module reaches for is
// replaced before it is imported, and the calls are inspected per test.
mock.module('server-only', () => ({}));

const updateStatusForUser = mock(async () => {});
const getTranscript = mock(async (): Promise<unknown> => ({}));
const isAaiNotFound = mock((err: unknown) => (err as { status?: number })?.status === 404);
const giveUpOnAaiJob = mock(async () => true);
const onTranscriptCompleted = mock(() => {});
const queueRecordingGraphSync = mock(() => {});

mock.module('@/db-ops/transcripts', () => ({ updateStatusForUser }));
mock.module('@/lib/server/assemblyai', () => ({ getTranscript, isAaiNotFound }));
mock.module('@/lib/server/aai-giveup', () => ({ giveUpOnAaiJob }));
mock.module('@/lib/server/post-completion', () => ({ onTranscriptCompleted }));
mock.module('@/lib/server/recording-sync', () => ({ queueRecordingGraphSync }));

const { refreshPendingAgainstAai } = await import('@/lib/server/aai-pending-refresh');

function row(over: Record<string, unknown>) {
  return {
    user_id: 'u1',
    assemblyai_id: 'meeting-1',
    status: 'processing',
    created_at: '2026-09-22T05:00:00Z',
    completed_at: null,
    duration: null,
    speaker_count: null,
    aai_job_id: 'job-1',
    ...over,
  } as never;
}

beforeEach(() => {
  for (const m of [updateStatusForUser, getTranscript, giveUpOnAaiJob, onTranscriptCompleted, queueRecordingGraphSync]) {
    m.mockClear();
  }
});

describe('refreshPendingAgainstAai — the one completion path the listing and the sweeper share', () => {
  test('a job AssemblyAI has finished: payload stored in the completion write, graph mirrored, post-completion fired', async () => {
    getTranscript.mockResolvedValueOnce({
      status: 'completed',
      completed: '2026-09-22T05:10:00Z',
      audio_duration: 484,
      language_code: 'en',
      utterances: [{ speaker: 'A' }, { speaker: 'B' }, { speaker: 'A' }],
    });
    const rows = [row({})];
    await refreshPendingAgainstAai(rows);

    expect(getTranscript).toHaveBeenCalledWith('job-1'); // the JOB, never the meeting id
    expect(updateStatusForUser).toHaveBeenCalledTimes(1);
    const [uid, mid, patch] = updateStatusForUser.mock.calls[0]! as unknown as [string, string, Record<string, unknown>];
    expect([uid, mid]).toEqual(['u1', 'meeting-1']);
    expect(patch.status).toBe('completed');
    expect(patch.speakerCount).toBe(2);
    expect((patch.content as { status: string }).status).toBe('completed'); // DEC-4: same write
    expect(queueRecordingGraphSync).toHaveBeenCalledWith('u1', 'meeting-1', 'listing-refresh');
    expect(onTranscriptCompleted).toHaveBeenCalledWith('u1', 'meeting-1', { utterances: 3 });
    expect((rows[0] as { status: string }).status).toBe('completed'); // patched in place for the caller's log line
  });

  test('still processing at AssemblyAI: status written, no payload, no post-completion', async () => {
    getTranscript.mockResolvedValueOnce({ status: 'processing', utterances: null });
    await refreshPendingAgainstAai([row({})]);
    const patch = updateStatusForUser.mock.calls[0]![2] as unknown as Record<string, unknown>;
    expect(patch.status).toBe('processing');
    expect(patch.content).toBeNull();
    expect(onTranscriptCompleted).not.toHaveBeenCalled();
  });

  test('a 404 is final: the row is given up, nothing else is written', async () => {
    getTranscript.mockRejectedValueOnce({ status: 404 });
    const rows = [row({})];
    await refreshPendingAgainstAai(rows);
    expect(giveUpOnAaiJob).toHaveBeenCalledTimes(1);
    expect(updateStatusForUser).not.toHaveBeenCalled();
    expect((rows[0] as { status: string }).status).toBe('error');
  });

  test('rows with no job, and finished / uploading / waiting rows, never reach AssemblyAI', async () => {
    await refreshPendingAgainstAai([
      row({ aai_job_id: null }), // a text-import or minted placeholder
      row({ assemblyai_id: 'm2', status: 'completed' }),
      row({ assemblyai_id: 'm3', status: 'uploading' }),
      row({ assemblyai_id: 'm4', status: 'waiting' }),
      row({ assemblyai_id: 'm5', status: 'error' }),
    ]);
    expect(getTranscript).not.toHaveBeenCalled();
  });

  test('prod 2026-10-02: a meeting made early from a recording is never polled, never given up on', async () => {
    // transcripts 1054: processing, minted UUID id, no job of its own. The
    // pending/stranded queries now hand it over with aai_job_id NULL (the SQL
    // twin no longer falls back to the meeting id), and the legacy listing's
    // lookup answers NULL for it too.
    const madeEarly = {
      assemblyai_id: '2bd949dd-c829-4cdd-a2b6-d2a86b2eefd5',
      status: 'processing',
      aai_job_id: null,
    };
    const rows = [row(madeEarly)];
    await refreshPendingAgainstAai(rows);
    const lookup = mock(async (ids: string[]) => new Map(ids.map((id) => [id, null])));
    await refreshPendingAgainstAai([row({ ...madeEarly, aai_job_id: undefined })], lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(getTranscript).not.toHaveBeenCalled();
    expect(giveUpOnAaiJob).not.toHaveBeenCalled();
    expect(updateStatusForUser).not.toHaveBeenCalled();
    expect((rows[0] as { status: string }).status).toBe('processing');
  });

  test('legacy rows without the job column resolve it through the caller-scoped lookup', async () => {
    getTranscript.mockResolvedValueOnce({ status: 'queued', utterances: null });
    const lookup = mock(async (ids: string[]) => new Map(ids.map((id) => [id, id === 'meeting-1' ? 'job-x' : null])));
    await refreshPendingAgainstAai(
      [row({ aai_job_id: undefined }), row({ assemblyai_id: 'no-job', aai_job_id: undefined })],
      lookup
    );
    expect(lookup).toHaveBeenCalledWith(['meeting-1', 'no-job']);
    expect(getTranscript).toHaveBeenCalledTimes(1);
    expect(getTranscript).toHaveBeenCalledWith('job-x');
  });
});
