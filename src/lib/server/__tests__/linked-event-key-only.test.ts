import { describe, expect, mock, test } from 'bun:test';

mock.module('server-only', () => ({}));

const { linkedEventKeyOnly } = await import('@/lib/server/upload-pipeline');

describe('linkedEventKeyOnly — the tray sends a bare key after Link is tapped', () => {
  test('a key-only payload is a ref', () => {
    expect(linkedEventKeyOnly({ key: 'bgs-zqvv-dby|2026-09-22T15:30:00+08:00' })).toBe(
      'bgs-zqvv-dby|2026-09-22T15:30:00+08:00'
    );
    expect(linkedEventKeyOnly({ key: '  abc  ' })).toBe('abc');
  });
  test('a real event payload is not — the stepper already resolved it', () => {
    expect(linkedEventKeyOnly({ key: 'x', id: 'ev1', title: 'Triton next steps!' })).toBeNull();
    expect(linkedEventKeyOnly({ key: 'x', meetingCode: 'bgs-zqvv-dby' })).toBeNull();
  });
  test('no payload, no key, garbage → null', () => {
    expect(linkedEventKeyOnly(undefined)).toBeNull();
    expect(linkedEventKeyOnly(null)).toBeNull();
    expect(linkedEventKeyOnly({})).toBeNull();
    expect(linkedEventKeyOnly({ key: '' })).toBeNull();
    expect(linkedEventKeyOnly('key')).toBeNull();
  });
});
