/**
 * P2 (docs/recordings-meetings-series-design.md §5, F2): the cross-user
 * recorder surface is gone, and must stay gone.
 *
 * Invariant I2 — for a caller who is not the owner and holds no access to a
 * meeting with a clip on recording R, every route under `/api/recorder/**`
 * answers exactly as it would for a recording that does not exist. The two
 * things that broke it were an API and a button:
 *
 *   GET /api/recorder/recordings?event=<ref>  → recordings of ANY owner for
 *     an occurrence the caller was merely INVOLVED in, redacted to owner
 *     email + state + timings + the meeting id (`othersView`).
 *   POST /api/recorder/recordings/:id/nudge   → "Ask Kawen to upload", an
 *     action on a colleague's private recording, offered on a machine match.
 *
 * Involvement in an occurrence is a gate on the OCCURRENCE; the only gate on
 * a recording is a meeting. These assertions are deliberately made against
 * the SOURCE: what must hold is that the code is not there to be called, and
 * that is what a reviewer would check by hand. The two-user database proof
 * for the fold itself is db-ops/__tests__/recorder-occurrence-scope.test.ts
 * plus the scratch-cluster check named in the design's As-built section.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('the "Ask to upload" nudge', () => {
  test('the route does not exist', () => {
    expect(existsSync(join(ROOT, 'app/api/recorder/recordings/[id]/nudge/route.ts'))).toBe(false);
  });

  test('nothing calls it, and no UI offers it', () => {
    for (const f of ['components/recording-strip.tsx', 'lib/recording-strip.ts', 'lib/recorder.ts']) {
      expect(read(f)).not.toContain('/nudge');
    }
    // The strip's action vocabulary no longer has a word for it.
    expect(read('lib/recording-strip.ts')).toContain("export type StripActionKind = 'upload' | 'open-recorder' | 'open'");
  });

  test('the recorder_nudges table is never read or written', () => {
    // The table itself stays (no migration); nothing touches it.
    expect(read('db-ops/recorder.ts')).not.toContain('recorder_nudges');
    for (const f of ['app/api/calendar-meetings/route.ts', 'app/api/recorder/recordings/route.ts']) {
      expect(read(f)).not.toContain('Nudge');
    }
  });
});

describe('GET /api/recorder/recordings', () => {
  const route = read('app/api/recorder/recordings/route.ts');

  test('serves ?mine=1 and nothing else', () => {
    expect(route).toContain("params.get('mine') === '1'");
    expect(route).toContain('listOwnRecordings(user.userId)');
    // The owner's listing is what the Recordings surface and the tray read;
    // its shape is untouched.
    expect(route).toContain('rows.map(ownView)');
  });

  test('?event= lists nothing — it answers 400, it does not fall through', () => {
    expect(route).not.toContain('recordingsForOccurrence');
    expect(route).not.toContain('othersView');
    expect(route).toContain("params.get('event')");
    expect(route).toContain('status: 400');
  });
});

describe('the wire shapes', () => {
  const view = read('lib/server/recorder-view.ts');

  test('there is only an owner view', () => {
    expect(view).toContain('export function ownView(');
    expect(view).not.toContain('export function othersView(');
    expect(view).not.toContain('OthersRecordingView');
  });

  test('a calendar row’s recorder ref carries no nudge state', () => {
    expect(read('lib/recorder.ts')).not.toContain('nudgedAt');
    expect(read('app/api/calendar-meetings/route.ts')).not.toContain('nudged_at');
  });
});
