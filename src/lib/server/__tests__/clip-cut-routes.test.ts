/**
 * Where the clip cut is wired (2026-10-02). The routes need a database and a
 * session to run, so these read their SOURCE and pin the order of the checks
 * that make the privacy rule hold: a windowed file is cut BEFORE anything could
 * hand out the whole recording, a frame is refused BEFORE the cache is read,
 * and the cuts are dropped wherever a meeting's clips change or it is deleted.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('the meeting media routes reveal only the window', () => {
  test('/audio: the cut is decided before the Stage B redirect and the blob proxy', () => {
    const src = read('app/api/transcripts/[id]/audio/route.ts');
    const body = src.slice(src.indexOf('async function serveMedia('));
    const cut = body.indexOf('cutWindowOf(media)');
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(body.indexOf('mediaSasRedirect('));
    expect(cut).toBeLessThan(body.indexOf('proxyBlobRange('));
    // A windowed canonical that fails never falls through to `audio_url`.
    expect(src).toContain('if (cutWindowOf(canonical))');
  });

  test('/frames: the window and hole refusal runs before the frame cache is touched', () => {
    const src = read('app/api/transcripts/[id]/frames/[frame]/route.ts');
    const refusal = src.indexOf('frameRefusal({');
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(src.indexOf('framePath(access.row.assemblyai_id, ms)'));
    expect(refusal).toBeLessThan(src.indexOf('await extractFrameFromMedia('));
    expect(src).toContain('holesFromContext(');
  });

  test('the AI notes frame grab applies the same refusal', () => {
    const src = read('lib/server/auto-notes.ts');
    expect(src).toContain('frameRefusal({ media: source, fileMs, meetingMs: ms })');
  });

  test('cuts are dropped when the clips change and when the meeting is deleted', () => {
    const clips = read('db-ops/clips.ts');
    const mirror = clips.slice(clips.indexOf('export async function setClipMirror('));
    expect(mirror.slice(0, mirror.indexOf('\n}\n'))).toContain('await dropClipCuts(assemblyaiId)');
    expect(read('app/api/transcripts/[id]/route.ts')).toContain('await dropClipCuts(access.row.assemblyai_id)');
  });

  test('a missing windowed source is pulled from the archive, never served whole', () => {
    const src = read('app/api/transcripts/[id]/audio/route.ts');
    const body = src.slice(src.indexOf('async function serveClipCut('));
    expect(body).toContain('media,');
    expect(read('lib/server/clip-cut.ts')).toContain('await ensureLocalMedia(req.media');
  });
});
