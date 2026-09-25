/**
 * One-off backfill: stored multi-track files whose RAW tracks still carry the
 * MP4 enabled bit (`tkhd` flag 1, ffprobe `disposition.default`).
 *
 * Why (2026-09-25): AVFoundation — Safari, QuickTime, iOS — plays EVERY
 * enabled audio track of an MP4 at once, Chrome only the first. Darth
 * Recorder ≥ 0.3.12 writes its live mix as track 0 and the raw system + mic
 * tracks after it, all enabled, and `normalizeMultiTrack` left such a file
 * untouched (only the server-mixed files had their raw tracks cleared). In
 * Safari the other party of a call heard their own voice twice (transcript
 * 973). Ingest now clears the bit (`keepOnlyMixEnabled`, lib/server/
 * multitrack.ts); this walks the files already on disk.
 *
 * Per file: ffprobe → if ≥ 2 audio streams and any stream after the first is
 * default → stream-copy remux with `-disposition:a:0 default`, the rest 0,
 * atomic rename over the original (bytes unchanged bar the flag, seconds per
 * file) → every `recording_media` row naming the file is re-archived with
 * `rehash` so the blob copy matches the file again.
 *
 *   bun --conditions=react-server scripts/fix-track-dispositions.ts            # dry run: list what would change
 *   bun --conditions=react-server scripts/fix-track-dispositions.ts --apply    # rewrite + re-archive
 *   … [--limit N] [--only <filename>]
 */
import { readdirSync } from 'node:fs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1]! : null;

const { getAudioDir } = await import('@/lib/server/audio-storage');
const { probeAudioStreams, rawTracksEnabled, keepOnlyMixEnabled, isMixTrack } = await import('@/lib/server/multitrack');
const { sql } = await import('@/lib/db');
const { SCHEMAS } = await import('@/lib/constants/database');
const { archiveMedia } = await import('@/lib/server/media-archive');
type RecordingMediaRow = import('@/db-ops/recordings').RecordingMediaRow;

const dir = getAudioDir();
const names = readdirSync(dir)
  .filter((n) => /\.(m4a|mp4|mov)$/i.test(n) && !n.includes('.tmp'))
  .filter((n) => !ONLY || n === ONLY)
  .sort();
console.log(`[dispositions] ${names.length} candidate file(s) in ${dir} — ${APPLY ? 'APPLY' : 'dry run'}`);

let probed = 0;
let affected = 0;
let fixed = 0;
let rearchived = 0;
let failed = 0;
const affectedNames: string[] = [];

for (const name of names) {
  if (LIMIT !== null && affected >= LIMIT) break;
  let streams;
  try {
    streams = await probeAudioStreams(name);
  } catch (err) {
    failed++;
    console.warn(`[dispositions] ${name}: probe failed — ${String(err).slice(0, 200)}`);
    continue;
  }
  probed++;
  if (!rawTracksEnabled(streams)) continue;
  affected++;
  affectedNames.push(name);
  const mix = isMixTrack(streams[0]!) ? 'mix' : 'NO MIX TRACK FIRST';
  const langs = streams.map((s) => `${s.language ?? '?'}${s.isDefault ? '*' : ''}`).join(',');
  console.log(`[dispositions] ${name}: ${streams.length} audio tracks [${langs}] first=${mix}`);
  if (!APPLY) continue;
  if (!isMixTrack(streams[0]!)) {
    // A file whose first track is not a mix is a pre-0.3.12 tray file the
    // server never normalised (ingest fell back to the raw file) — leaving
    // only its first track enabled would silence the other side. Skip; it
    // needs `normalizeMultiTrack`, not this.
    console.warn(`[dispositions] ${name}: skipped — first track is not the mix`);
    continue;
  }
  try {
    await keepOnlyMixEnabled(name, streams.length);
    fixed++;
    const after = await probeAudioStreams(name);
    if (rawTracksEnabled(after)) throw new Error('raw tracks still enabled after remux');
  } catch (err) {
    failed++;
    console.warn(`[dispositions] ${name}: remux failed — ${String(err).slice(0, 300)}`);
    continue;
  }
  try {
    const rows = await sql<RecordingMediaRow[]>`
      SELECT * FROM ${sql(SCHEMAS.MEETING_WHISPERER)}.recording_media WHERE filename = ${name}
    `;
    for (const row of rows) {
      const out = await archiveMedia(row, { rehash: true });
      if (out.status === 'archived') rearchived++;
      console.log(`[dispositions] ${name}: media ${row.id} archive → ${out.status}${'reason' in out && out.reason ? ` (${out.reason})` : ''}`);
    }
  } catch (err) {
    console.warn(`[dispositions] ${name}: re-archive failed — ${String(err).slice(0, 300)}`);
  }
}

console.log(
  `[dispositions] done: probed ${probed}, affected ${affected}, ${APPLY ? `fixed ${fixed}, re-archived ${rearchived}, ` : ''}failed ${failed}`
);
if (!APPLY && affectedNames.length > 0) console.log(affectedNames.map((n) => `  ${n}`).join('\n'));
process.exit(0);
