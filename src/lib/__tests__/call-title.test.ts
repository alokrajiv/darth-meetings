import { describe, expect, test } from 'bun:test';
import { callCounterpart, cleanCallTitle, describeCallKind, isOneToOneCall } from '@/lib/call-title';

const LRM = String.fromCharCode(0x200e); // WhatsApp's left-to-right mark

describe('callCounterpart', () => {
  test('WhatsApp voice call title → the contact, invisible marks stripped', () => {
    // exactly what the tray stored for transcript 973 (U+200E before the name)
    expect(callCounterpart({ kind: 'whatsapp', title: LRM + 'Yadu N M - WhatsApp voice call' })).toBe('Yadu N M');
  });
  test('WhatsApp video call', () => {
    expect(callCounterpart({ kind: 'whatsapp', title: 'Ivan Seow - WhatsApp video call' })).toBe('Ivan Seow');
  });
  test('a bare "WhatsApp" window is not a counterpart', () => {
    expect(callCounterpart({ kind: 'whatsapp', title: LRM + 'WhatsApp' })).toBeNull();
    expect(callCounterpart({ kind: 'whatsapp', title: 'WhatsApp - WhatsApp voice call' })).toBeNull();
  });
  test('FaceTime names the window after the person; "FaceTime" alone is nobody', () => {
    expect(callCounterpart({ kind: 'facetime', title: 'Radhika Rungta' })).toBe('Radhika Rungta');
    expect(callCounterpart({ kind: 'facetime', title: 'FaceTime' })).toBeNull();
  });
  test('group calls have no counterpart in the title', () => {
    expect(callCounterpart({ kind: 'meet', title: 'DevOps Scrum – Google Meet' })).toBeNull();
    expect(callCounterpart({ kind: 'teams', title: 'MSC Contract | Microsoft Teams' })).toBeNull();
    expect(callCounterpart(null)).toBeNull();
  });
});

describe('helpers', () => {
  test('isOneToOneCall', () => {
    expect(isOneToOneCall('whatsapp')).toBe(true);
    expect(isOneToOneCall('facetime')).toBe(true);
    expect(isOneToOneCall('meet')).toBe(false);
    expect(isOneToOneCall(undefined)).toBe(false);
  });
  test('describeCallKind', () => {
    expect(describeCallKind({ kind: 'whatsapp', title: 'X - WhatsApp voice call' })).toBe('WhatsApp voice call');
    expect(describeCallKind({ kind: 'whatsapp', title: 'X - WhatsApp video call' })).toBe('WhatsApp video call');
    expect(describeCallKind({ kind: 'slack', title: 'huddle' })).toBe('Slack huddle');
    expect(describeCallKind({ kind: 'other', app: LRM + 'Signal', title: 'x' })).toBe('Signal call');
  });
  test('cleanCallTitle', () => {
    expect(cleanCallTitle(LRM + '  Yadu   N M ' + LRM)).toBe('Yadu N M');
    expect(cleanCallTitle(null)).toBe('');
  });
});
