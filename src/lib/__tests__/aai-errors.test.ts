import { describe, expect, test } from 'bun:test';
import { describeAaiError, isAaiNotFound } from '@/lib/aai-errors';

/**
 * The shapes below are the three branches of assemblyai@4's
 * `BaseService.fetch` (dist/index.mjs:128-142): `json.error`, the raw body
 * text, and `HTTP Error: <status> <statusText>` for an empty body. The SDK
 * never attaches the status as a property, which is the whole reason this
 * helper exists.
 */
describe('describeAaiError — 404 is terminal', () => {
  test('empty-body branch: HTTP Error: 404 Not Found', () => {
    const info = describeAaiError(new Error('HTTP Error: 404 Not Found'));
    expect(info.status).toBe(404);
    expect(info.notFound).toBe(true);
  });

  test('json.error branch: AAI words it as a sentence', () => {
    expect(isAaiNotFound(new Error('Transcript not found'))).toBe(true);
    expect(isAaiNotFound(new Error('transcript with this id does not exist'))).toBe(true);
    expect(isAaiNotFound(new Error("that transcript doesn't exist"))).toBe(true);
  });

  test('raw JSON body text still reads as gone', () => {
    expect(isAaiNotFound(new Error('{"error":"Transcript not found"}'))).toBe(true);
  });

  test('a status property wins over the message when one is attached', () => {
    const err = Object.assign(new Error('something went wrong'), { status: 404 });
    expect(describeAaiError(err)).toMatchObject({ status: 404, notFound: true });
    const nested = Object.assign(new Error('boom'), { response: { status: 404 } });
    expect(isAaiNotFound(nested)).toBe(true);
  });

  test('a bare 404 in the message (the pre-helper deleteTranscript test)', () => {
    expect(isAaiNotFound(new Error('request failed with 404'))).toBe(true);
  });
});

describe('describeAaiError — everything else is retryable', () => {
  test('5xx and rate limits are not "gone"', () => {
    expect(isAaiNotFound(new Error('HTTP Error: 500 Internal Server Error'))).toBe(false);
    expect(isAaiNotFound(new Error('HTTP Error: 429 Too Many Requests'))).toBe(false);
    expect(describeAaiError(new Error('HTTP Error: 503 Service Unavailable')).status).toBe(503);
  });

  test('a 5xx whose body happens to mention "not found" is still retryable', () => {
    const err = Object.assign(new Error('upstream not found'), { status: 502 });
    expect(isAaiNotFound(err)).toBe(false);
  });

  test('auth and balance failures are not "gone"', () => {
    expect(isAaiNotFound(new Error('Authentication error, API token missing/invalid'))).toBe(false);
    expect(
      isAaiNotFound(new Error('Your account balance is negative. Please add funds.'))
    ).toBe(false);
  });

  test('network errors carry a string code, never a status', () => {
    const err = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    expect(describeAaiError(err)).toMatchObject({ status: null, notFound: false });
  });

  test('a job id containing digits never reads as a 404', () => {
    expect(isAaiNotFound(new Error('polling 14042404-4041-4404-8404-404440444044 failed'))).toBe(
      false
    );
  });
});

describe('describeAaiError — message normalisation', () => {
  test('non-Error throws survive', () => {
    expect(describeAaiError('Transcript not found').notFound).toBe(true);
    expect(describeAaiError({ error: 'weird' }).message).toBe('{"error":"weird"}');
    expect(describeAaiError(null).message).toBe('null');
  });

  test('whitespace collapsed and capped at 300 chars', () => {
    const info = describeAaiError(new Error(`a\n\n   b${' '}${'x'.repeat(400)}`));
    expect(info.message.length).toBe(300);
    expect(info.message.startsWith('a b')).toBe(true);
  });

  test('an empty message does not become an empty string', () => {
    expect(describeAaiError(new Error('')).message).toBe('unknown error');
  });
});
