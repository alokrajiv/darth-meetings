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
    // `cutPlanOf`, not `cutWindowOf`: a hole in the middle is cut too (M1).
    const cut = body.indexOf('cutPlanOf(media)');
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(body.indexOf('mediaSasRedirect('));
    expect(cut).toBeLessThan(body.indexOf('proxyBlobRange('));
    // A windowed canonical that fails never falls through to `audio_url`.
    expect(src).toContain('if (cutPlanOf(canonical))');
    expect(src).not.toContain('cutWindowOf(');
  });

  test('the resolver hands the kept segments to the route, in both resolvers', () => {
    const src = read('lib/server/recordings.ts');
    expect(src).toContain('keptMs: kept.length > 1 ? kept : null');
    expect(src).toContain("keptMs: m.kind === 'canonical' ? (windows.get(recordingId)?.kept ?? null) : null");
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

  test('every clip writer starts the cut (M2), and the sweeper backs it up under the drain', () => {
    const split = read('lib/server/clip-split.ts');
    expect(split).toContain("queueClipPrecut(newId, 'split')");
    expect(split).toContain("if (!input.keepInBoth) queueClipPrecut(row.assemblyai_id, 'split')");
    expect(split).toContain("queueClipPrecut(sourceAccess.row.assemblyai_id, 'unsplit')");
    expect(split).toContain('await dropClipCuts(row.assemblyai_id)'); // the un-split half's cuts go
    const combine = read('lib/server/clip-combine.ts');
    const mirror = combine.slice(combine.indexOf('async function writeMirrorAndMaterialise('));
    expect(mirror.slice(0, mirror.indexOf('\n}\n'))).toContain('queueClipPrecut(access.row.assemblyai_id, `combine-${what}`)');
    expect(combine).toContain("queueClipPrecut(access.row.assemblyai_id, 'combine-rollback')");
    expect(read('lib/server/recording-actions.ts')).toContain('queueClipPrecut(made.assemblyaiId, `recording-${opts.how}`)');
    expect(read('lib/server/recording-settle.ts')).toContain("queueClipPrecut(m.assemblyai_id, 'recording-settle')");
    // The backstop runs inside the sweeper's tick, which `unlessDraining` wraps.
    const sweeper = read('lib/server/media-sweeper.ts');
    const tick = sweeper.slice(sweeper.indexOf('async function tick('));
    expect(tick.slice(0, tick.indexOf('\n}\n'))).toContain('await precutBackstopPass()');
    expect(sweeper).toContain("unlessDraining('media-sweeper', tick)");
    // …and the pre-cut shares the routes' lock: it goes through ensureClipCut.
    expect(read('lib/server/clip-precut.ts')).toContain('await ensureClipCut(req)');
  });

  test('the offline plan reports the cut’s size, or an estimate it flags', () => {
    const src = read('app/api/offline/plan/route.ts');
    expect(src).toContain('await findClipCut({');
    expect(src).toContain('estimated: true');
    expect(read('db-ops/offline-plan.ts')).toContain("t.gmeet_context->'clips' AS clips");
  });

  test('a missing windowed source is pulled from the archive, never served whole', () => {
    const src = read('app/api/transcripts/[id]/audio/route.ts');
    const body = src.slice(src.indexOf('async function serveClipCut('));
    expect(body).toContain('media,');
    // Stage D readers: the cut's source ALWAYS goes through media-local (the
    // resolved media when the route has it), on disk or pulled, and is held.
    const cut = read('lib/server/clip-cut.ts');
    expect(cut).toContain('const source: LocalizableMedia = req.media ??');
    expect(cut).toContain('await ensureLocalMedia(source,');
  });
});
