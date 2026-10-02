/**
 * darth-admin › Recorder: the pure shaping of one tray (lib/recorder-admin.ts).
 */
import { describe, expect, test } from 'bun:test';
import {
  buildAdminDevice,
  compareVersions,
  currentRecordingRef,
  isOutdated,
  parseKinds,
  type AdminDeviceInput,
} from '@/lib/recorder-admin';

const NOW = Date.parse('2026-10-02T06:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const REC = '11111111-2222-4333-8444-555555555555';

function device(over: Partial<AdminDeviceInput> = {}): AdminDeviceInput {
  return {
    device_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    user_id: 'u1',
    email: 'a@example.test',
    hostname: 'mac-a',
    os: 'macOS 26.0',
    app_version: '0.3.21',
    first_seen: ago(60 * 24 * 10),
    last_seen: ago(2),
    last_status: { ts: ago(2), recording: false, calls: [] },
    last_event_at: null,
    resource_ts: null,
    resource_payload: null,
    life_kind: null,
    life_ts: null,
    life_payload: null,
    unclean_exits_7d: 0,
    ...over,
  };
}

describe('versions', () => {
  test('numeric compare, not lexical', () => {
    expect(compareVersions('0.3.9', '0.3.21')).toBe(-1);
    expect(compareVersions('0.3.21', '0.3.21')).toBe(0);
    expect(compareVersions('0.4.0', '0.3.99')).toBe(1);
    expect(compareVersions('v0.3', '0.3.0')).toBe(0);
  });
  test('outdated only when both are known and below', () => {
    expect(isOutdated('0.3.20', '0.3.21')).toBe(true);
    expect(isOutdated('0.3.21', '0.3.21')).toBe(false);
    expect(isOutdated(null, '0.3.21')).toBe(false);
    expect(isOutdated('0.3.20', null)).toBe(false);
  });
});

describe('liveness and state', () => {
  test('heartbeat within 6 min → live idle', () => {
    const d = buildAdminDevice(device(), { nowMs: NOW, latestVersion: '0.3.21' });
    expect(d.live).toBe(true);
    expect(d.state).toBe('idle');
    expect(d.outdated).toBe(false);
    expect(d.recording).toBeNull();
  });

  test('old heartbeat but a fresh event keeps it live', () => {
    const d = buildAdminDevice(device({ last_seen: ago(30), last_event_at: ago(1) }), { nowMs: NOW, latestVersion: null });
    expect(d.live).toBe(true);
  });

  test('nothing for > 6 min → offline, and never "recording"', () => {
    const d = buildAdminDevice(
      device({
        last_seen: ago(90),
        last_status: { ts: ago(90), recording: true, recording_id: REC, recording_since: ago(100) },
      }),
      { nowMs: NOW, latestVersion: '0.3.22' }
    );
    expect(d.live).toBe(false);
    expect(d.state).toBe('offline');
    expect(d.recording).toBeNull();
    expect(d.outdated).toBe(true);
  });

  test('a call in the snapshot → in_call', () => {
    const d = buildAdminDevice(
      device({ last_status: { ts: ago(2), recording: false, calls: [{ app: 'Microsoft Teams', kind: 'teams' }] } }),
      { nowMs: NOW, latestVersion: null }
    );
    expect(d.state).toBe('in_call');
    expect(d.calls).toHaveLength(1);
  });

  test('a fresh resource sample naming a call → in_call between heartbeats', () => {
    const d = buildAdminDevice(
      device({ resource_ts: ago(1), resource_payload: { ts: ago(1), call_app: 'Slack', recording: false, cpu_pct: 4.5 } }),
      { nowMs: NOW, latestVersion: null }
    );
    expect(d.state).toBe('in_call');
    expect(d.calls).toEqual([{ app: 'Slack', from: 'resource_sample' }]);
    expect(d.resources?.cpu_pct).toBe(4.5);
  });
});

describe('the recording right now', () => {
  const recordingStatus = {
    ts: ago(3),
    recording: true,
    recording_id: REC.toUpperCase(),
    recording_since: ago(20),
    segment: 1,
    source: { kind: 'window', title: 'Standup | Microsoft Teams', window_id: 42 },
    calls: [{ app: 'Microsoft Teams', kind: 'teams', title: 'Standup' }],
  };

  test('from the heartbeat snapshot, merged with progress events', () => {
    const d = buildAdminDevice(device({ last_status: recordingStatus }), {
      nowMs: NOW,
      latestVersion: null,
      progress: {
        device_id: 'x',
        recording_id: REC,
        max_segment: 2,
        closed_segments: 1,
        closed_bytes: '1048576',
        last_progress_at: ago(1),
        latest_source: { kind: 'display', display_id: 1 },
        call: { app: 'Microsoft Teams', kind: 'teams', title: 'Standup' },
        row_started_at: ago(20),
      },
    });
    expect(d.state).toBe('recording');
    expect(d.recording).toMatchObject({
      recording_id: REC,
      segments: 2,
      bytes: 1048576,
      seconds: 1200,
      source: { kind: 'display', display_id: 1 },
      call: { app: 'Microsoft Teams', kind: 'teams', title: 'Standup' },
      last_progress_at: ago(1),
      from: 'heartbeat',
    });
  });

  test('snapshot.recording false → null even with an older recording_started event', () => {
    const d = buildAdminDevice(
      device({ life_kind: 'recording_started', life_ts: ago(10), life_payload: { recording_id: REC } }),
      { nowMs: NOW, latestVersion: null }
    );
    expect(d.recording).toBeNull();
    expect(d.state).toBe('idle');
  });

  test('a recording_started NEWER than the snapshot is a recording the heartbeat has not seen yet', () => {
    const d = buildAdminDevice(
      device({
        last_event_at: ago(0.5),
        life_kind: 'recording_started',
        life_ts: ago(1),
        life_payload: { recording_id: REC, source: { kind: 'display', display_id: 2 } },
      }),
      { nowMs: NOW, latestVersion: null }
    );
    expect(d.state).toBe('recording');
    expect(d.recording?.from).toBe('events');
    expect(d.recording?.source).toEqual({ kind: 'display', display_id: 2 });
    expect(d.recording?.segments).toBe(1);
  });

  test('a recording_stopped newer than the snapshot ends it', () => {
    const d = buildAdminDevice(
      device({
        last_status: recordingStatus,
        life_kind: 'recording_stopped',
        life_ts: ago(1),
        life_payload: { recording_id: REC },
      }),
      { nowMs: NOW, latestVersion: null }
    );
    expect(d.recording).toBeNull();
    expect(d.state).toBe('in_call');
  });

  test('a stop of a DIFFERENT recording does not end this one', () => {
    const ref = currentRecordingRef(
      device({
        last_status: recordingStatus,
        life_kind: 'recording_stopped',
        life_ts: ago(1),
        life_payload: { recording_id: '99999999-2222-4333-8444-555555555555' },
      }),
      true
    );
    expect(ref?.recording_id).toBe(REC);
  });
});

describe('passthroughs', () => {
  test('local_disk, upload, share, pending, hardware, unclean exits, recent', () => {
    const local_disk = { dir: '/x', total_bytes: 10, files: 2, pending_upload_bytes: 5, orphan_bytes: 1 };
    const d = buildAdminDevice(
      device({
        unclean_exits_7d: '2',
        last_status: {
          ts: ago(1),
          recording: false,
          local_disk,
          upload: { recording_id: REC, progress: 0.4 },
          share: { app: 'Teams', kind: 'window', target: 'Deck' },
          recordings_pending_upload: 3,
          telemetry_level: 'partial',
          screen_recording_permission: false,
          signed_in: true,
          hardware: { chip: 'Apple M3 Pro', ram_gb: 36, hw_model: 'Mac15,6', cpu_cores: 12 },
        },
      }),
      {
        nowMs: NOW,
        latestVersion: null,
        recent: [
          {
            id: REC,
            device_id: 'x',
            started_at: new Date(NOW - 3_600_000) as unknown as string,
            duration_s: 1800,
            bytes: '123',
            status: 'uploaded',
            transcript_id: 'abc',
            recording_id: null,
            error: null,
            call_app: 'Zoom',
          },
        ],
      }
    );
    expect(d.local_disk).toEqual(local_disk);
    expect(d.upload).toEqual({ recording_id: REC, progress: 0.4 });
    expect(d.share).toMatchObject({ kind: 'window' });
    expect(d.pending_uploads).toBe(3);
    expect(d.telemetry_level).toBe('partial');
    expect(d.screen_recording_permission).toBe(false);
    expect(d.hardware).toEqual({ chip: 'Apple M3 Pro', ram_gb: 36, hw_model: 'Mac15,6' });
    expect(d.unclean_exits_7d).toBe(2);
    expect(d.recent_recordings[0]).toMatchObject({ bytes: 123, call_app: 'Zoom', started_at: ago(60) });
  });

  test('an absent local_disk is null (tray < 0.3.22)', () => {
    expect(buildAdminDevice(device(), { nowMs: NOW, latestVersion: null }).local_disk).toBeNull();
  });
});

describe('parseKinds', () => {
  test('csv → clean unique list; junk dropped; empty → null', () => {
    expect(parseKinds('call_started, call_ended,call_started')).toEqual(['call_started', 'call_ended']);
    expect(parseKinds("x'; drop,ok")).toEqual(['ok']);
    expect(parseKinds('')).toBeNull();
    expect(parseKinds(null)).toBeNull();
  });
});
