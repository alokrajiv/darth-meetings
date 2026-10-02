import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DRAIN_FILE,
  __resetDrainForTests,
  isDraining,
  resumeIfUndrained,
  unlessDraining,
} from '../deploy-drain';

describe('deploy drain gate', () => {
  let dir: string;
  let prevCwd: string;
  const drain = () => writeFileSync(path.join(dir, DRAIN_FILE), '');
  const undrain = () => rmSync(path.join(dir, DRAIN_FILE), { force: true });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'mw-drain-'));
    prevCwd = process.cwd();
    process.chdir(dir);
    __resetDrainForTests();
  });

  afterEach(() => {
    __resetDrainForTests();
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test('no file → not draining, the job runs at once', () => {
    let runs = 0;
    expect(isDraining()).toBe(false);
    unlessDraining('t', () => {
      runs++;
    })();
    expect(runs).toBe(1);
  });

  test('file present → the job is skipped', () => {
    drain();
    let runs = 0;
    expect(isDraining()).toBe(true);
    const cb = unlessDraining('t', () => {
      runs++;
    });
    cb();
    cb();
    expect(runs).toBe(0);
  });

  test('the file is checked per call, not once', () => {
    let runs = 0;
    const cb = unlessDraining('t', () => {
      runs++;
    });
    cb();
    drain();
    cb();
    undrain();
    cb();
    expect(runs).toBe(2);
  });

  test('skipped jobs are owed: one catch-up run per label once the file is gone', () => {
    const runs: string[] = [];
    const a1 = unlessDraining('a', () => runs.push('a'));
    const a2 = unlessDraining('a', () => runs.push('a'));
    const b = unlessDraining('b', () => runs.push('b'));
    drain();
    a1();
    a2();
    b();
    a1();
    expect(resumeIfUndrained()).toBe(0); // still draining
    expect(runs).toEqual([]);
    undrain();
    expect(resumeIfUndrained()).toBe(2);
    expect(runs.sort()).toEqual(['a', 'b']);
    expect(resumeIfUndrained()).toBe(0); // nothing owed any more
  });

  test('a throwing or rejecting job does not escape', async () => {
    unlessDraining('sync', () => {
      throw new Error('boom');
    })();
    unlessDraining('async', async () => {
      throw new Error('boom');
    })();
    await new Promise((r) => setTimeout(r, 0));
  });

  test('an explicit cwd is honoured', () => {
    expect(isDraining('/definitely/not/here')).toBe(false);
  });
});
