import { describe, expect, test } from 'bun:test';
import { listingCoversWindow } from '@/lib/calendar-listing';

describe('listingCoversWindow', () => {
  const full = { truncated: false, pageFailed: false };

  test('complete unfiltered primary listing may prune', () => {
    expect(listingCoversWindow(full)).toBe(true);
    expect(listingCoversWindow({ ...full, calendarId: 'primary', q: '', iCalUID: null })).toBe(true);
  });

  test('page cap hit with a nextPageToken left → no prune', () => {
    expect(listingCoversWindow({ ...full, truncated: true })).toBe(false);
  });

  test('a later page failed → no prune', () => {
    expect(listingCoversWindow({ ...full, pageFailed: true })).toBe(false);
  });

  test('filtered listings never prune', () => {
    expect(listingCoversWindow({ ...full, q: 'standup' })).toBe(false);
    expect(listingCoversWindow({ ...full, iCalUID: 'abc@google.com' })).toBe(false);
  });

  test('another calendar never prunes', () => {
    expect(listingCoversWindow({ ...full, calendarId: 'colleague@trames.sg' })).toBe(false);
  });
});
