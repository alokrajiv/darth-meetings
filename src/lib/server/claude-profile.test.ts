import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyClaudeFailure, readProfileToken, resolveClaudeProfiles, tokenPath } from './claude-profile';

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(80);

describe('readProfileToken (mirrors chat creds.ts)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mw-creds-'));
    writeFileSync(path.join(dir, 'ok.token'), `${TOKEN}\n`, { mode: 0o600 });
    writeFileSync(path.join(dir, 'loose.token'), TOKEN, { mode: 0o600 });
    chmodSync(path.join(dir, 'loose.token'), 0o644);
    writeFileSync(path.join(dir, 'two.token'), 'a\nb\n', { mode: 0o600 });
    writeFileSync(path.join(dir, 'space.token'), 'sk ant\n', { mode: 0o600 });
    symlinkSync(path.join(dir, 'ok.token'), path.join(dir, 'link.token'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('valid: mode 600, one printable line, trailing newline ok', async () => {
    expect(await readProfileToken(tokenPath(dir, 'ok'))).toEqual({ state: 'valid', token: TOKEN });
  });
  test('missing file', async () => {
    expect(await readProfileToken(tokenPath(dir, 'nope'))).toEqual({ state: 'missing' });
  });
  test('group/other-readable is unusable', async () => {
    const r = await readProfileToken(tokenPath(dir, 'loose'));
    expect(r.state).toBe('invalid');
    if (r.state === 'invalid') expect(r.reason).toContain('must be 600');
  });
  test('two lines / whitespace are unusable', async () => {
    expect((await readProfileToken(tokenPath(dir, 'two'))).state).toBe('invalid');
    expect((await readProfileToken(tokenPath(dir, 'space'))).state).toBe('invalid');
  });
  test('a symlink to a valid token is accepted (stat follows it)', async () => {
    expect((await readProfileToken(tokenPath(dir, 'link'))).state).toBe('valid');
  });
});

describe('resolveClaudeProfiles without the shared-login env', () => {
  test('returns [] so the runner keeps the host login', async () => {
    const prev = { dir: process.env.MW_CLAUDE_CREDS_DIR, db: process.env.MW_DARTH_CHAT_DATABASE_URL };
    delete process.env.MW_CLAUDE_CREDS_DIR;
    delete process.env.MW_DARTH_CHAT_DATABASE_URL;
    try {
      expect(await resolveClaudeProfiles()).toEqual([]);
    } finally {
      if (prev.dir) process.env.MW_CLAUDE_CREDS_DIR = prev.dir;
      if (prev.db) process.env.MW_DARTH_CHAT_DATABASE_URL = prev.db;
    }
  });
  test('creds dir alone (no chat db) falls back to MW_CLAUDE_PROFILE_DEFAULT', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mw-creds-'));
    writeFileSync(path.join(dir, 'p1.token'), `${TOKEN}\n`, { mode: 0o600 });
    const prev = { dir: process.env.MW_CLAUDE_CREDS_DIR, db: process.env.MW_DARTH_CHAT_DATABASE_URL, def: process.env.MW_CLAUDE_PROFILE_DEFAULT };
    process.env.MW_CLAUDE_CREDS_DIR = dir;
    delete process.env.MW_DARTH_CHAT_DATABASE_URL;
    process.env.MW_CLAUDE_PROFILE_DEFAULT = 'p1';
    try {
      const got = await resolveClaudeProfiles();
      expect(got.map((c) => [c.profile, c.source])).toEqual([['p1', 'default']]);
      expect(got[0].token).toBe(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prev.dir) process.env.MW_CLAUDE_CREDS_DIR = prev.dir; else delete process.env.MW_CLAUDE_CREDS_DIR;
      if (prev.db) process.env.MW_DARTH_CHAT_DATABASE_URL = prev.db;
      if (prev.def) process.env.MW_CLAUDE_PROFILE_DEFAULT = prev.def; else delete process.env.MW_CLAUDE_PROFILE_DEFAULT;
    }
  });
});

describe('classifyClaudeFailure', () => {
  test('the 2026-10-08 message is auth', () => {
    expect(
      classifyClaudeFailure('Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed')
    ).toBe('auth');
  });
  test('usage windows are rate_limit', () => {
    expect(classifyClaudeFailure("You've hit your limit · resets 8pm")).toBe('rate_limit');
    expect(classifyClaudeFailure('API Error: 429 rate_limit_error')).toBe('rate_limit');
  });
  test('anything else is null (no swap)', () => {
    expect(classifyClaudeFailure('agent run failed (error_during_execution): Controller is closed')).toBeNull();
    expect(classifyClaudeFailure('agent run timed out after 600s')).toBeNull();
  });
});
