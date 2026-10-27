/**
 * Speaker identity (phase 1, 2026-10-27) — the UI half. The pure rules live
 * in lib/speaker-identity (speaker-identity.test.ts); what these tests hold:
 *
 *  - People card: a confirmed label with an email shows the ✓ marker
 *    (`data-speaker-email`), rendered statically (no DOM); a name-only label,
 *    a guess and a group label show none;
 *  - Confirm on a suggestion that carries an email saves `{customName, email}`
 *    — pinned from source (the row is not exported, a static render can't
 *    click);
 *  - "+ Person" dialog: opens with the invitee's email prefilled and says
 *    "From the invite" while the field still holds it — pinned from source
 *    (the Radix dialog portals, so a static render is empty);
 *  - the guess row shows the PERSON: the suggestion's email and where it came
 *    from (`identitySource`), or "no email match"; the review dialog caption
 *    and the transcript badge tooltip say the same (pinned from source);
 *  - the detail page: saves keep / drop / attach the email by the rules, and
 *    the auto-proceed line names the people the pass would apply.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { PeopleCard } from '@/components/people-card';
import type { SpeakerLabel, SpeakerSuggestionMap } from '@/lib/format';

const root = join(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const utterances = [
  { text: 'Hello.', start: 0, end: 1000, speaker: 'A' },
  { text: 'Hi.', start: 1000, end: 2000, speaker: 'B' },
  { text: 'Morning.', start: 2000, end: 3000, speaker: 'C' },
];

const render = (speakerLabels: SpeakerLabel[], suggestions: SpeakerSuggestionMap = {}) =>
  renderToStaticMarkup(
    <PeopleCard
      utterances={utterances}
      speakerLabels={speakerLabels}
      suggestions={suggestions}
      onSave={() => {}}
      canEdit
      onPickPerson={() => {}}
      onRequestCreatePerson={() => {}}
      audioSrc={null}
    />
  );

describe('People card — the ✓ email marker', () => {
  test('a confirmed label with an email renders the marker, titled with the email', () => {
    const html = render([
      { originalSpeaker: 'A', customName: 'Test Person A', description: '', email: 'test-a@example.com' },
      { originalSpeaker: 'B', customName: 'Test Person B', description: '' },
    ]);
    expect(html).toContain('data-speaker-email="test-a@example.com"');
    expect(html).toContain('title="test-a@example.com"');
    expect(html.match(/data-speaker-email=/g)?.length).toBe(1);
  });

  test('name-only labels, guesses and group labels render none', () => {
    const html = render(
      [
        { originalSpeaker: 'A', customName: 'Test Person A', description: '' },
        { originalSpeaker: 'C', customName: 'mixed', description: '', email: 'test-c@example.com' },
      ],
      { B: { name: 'Test Person B', confidence: 0.9, source: 'context', email: 'test-b@example.com' } }
    );
    expect(html).toContain('data-speaker-state="guess"');
    expect(html).toContain('data-speaker-state="group"');
    expect(html).not.toContain('data-speaker-email');
  });
});

describe('People card — the guess row shows the person', () => {
  /** The span carrying `data-suggestion-email="<email>"`, as markup. */
  const personSpan = (html: string, email: string) => {
    const m = html.match(new RegExp(`<span[^>]*data-suggestion-email="${email}"[^>]*>([^<]*)</span>`));
    return m ? { tag: m[0], text: m[1]! } : null;
  };

  test('an invite email: the email · "on the invite", titled with the email', () => {
    const html = render([], {
      A: { name: 'Test Person A', confidence: 0.9, source: 'context', email: 'test-a@example.com', emailSource: 'invite' },
    });
    const span = personSpan(html, 'test-a@example.com');
    expect(span).not.toBeNull();
    expect(span!.text).toContain('test-a@example.com');
    expect(span!.text).toContain('on the invite');
    expect(span!.tag).toContain('data-suggestion-source="invite"');
    expect(span!.tag).toContain('title="test-a@example.com"');
  });

  test('a directory email: "in the directory"', () => {
    const html = render([], {
      B: { name: 'Test Person B', confidence: 0.9, source: 'voice', email: 'test-b@example.com', emailSource: 'directory' },
    });
    const span = personSpan(html, 'test-b@example.com');
    expect(span).not.toBeNull();
    expect(span!.text).toContain('in the directory');
    expect(span!.tag).toContain('data-suggestion-source="directory"');
  });

  test('an email without a source reads as the invite (the older suggestions)', () => {
    const html = render([], {
      A: { name: 'Test Person A', confidence: 0.9, source: 'context', email: 'test-a@example.com' },
    });
    expect(personSpan(html, 'test-a@example.com')!.text).toContain('on the invite');
  });

  test('a guess without an email: "no email match"', () => {
    const html = render([], { C: { name: 'Test Person C', confidence: 0.9, source: 'context' } });
    const span = personSpan(html, '');
    expect(span).not.toBeNull();
    expect(span!.text).toBe('no email match');
  });

  test('confirmed labels show no suggestion line', () => {
    const html = render(
      [{ originalSpeaker: 'A', customName: 'Test Person A', description: '' }],
      { A: { name: 'Test Person A', confidence: 0.9, source: 'context', email: 'test-a@example.com' } }
    );
    expect(html).not.toContain('data-suggestion-email');
  });
});

describe('review dialog, transcript badge, detail page — the person wording', () => {
  test('the review dialog caption uses identitySource and marks the email', () => {
    const src = read('components/speaker-review-dialog.tsx');
    expect(src).toContain("import { identitySource } from '@/lib/speaker-identity';");
    expect(src).toContain('identitySource(suggestion)');
    expect(src).toContain("data-suggestion-email={suggestion.email ?? ''}");
  });

  test('the transcript badge tooltip names the person via identitySource', () => {
    const src = read('components/speaker-badge-editor.tsx');
    expect(src).toContain('identitySource(state.suggestion)');
    expect(src).toContain('`Guessed — ${state.caption}${guessPerson}`');
  });

  test('the auto-proceed line names who the pass would apply', () => {
    const src = read('app/transcript/[id]/page.tsx');
    expect(src).toContain("import { evaluateAutoReview } from '@/lib/auto-review-eval';");
    expect(src).toContain('evaluateAutoReview(');
    expect(src).toContain('if (!evaluation.passed) return [];');
    expect(src).toContain('autoProceedLine(row.autoProceedAt, undefined, autoProceedPeople)');
  });
});

describe('People card — Confirm saves the person', () => {
  const src = read('components/people-card.tsx');

  test('onSave takes an email in its patch', () => {
    expect(src).toContain(
      'onSave: (originalSpeaker: string, patch: { customName?: string; description?: string; email?: string }) => void;'
    );
  });

  test('a suggestion with an email confirms {customName, email}; without, the name only', () => {
    expect(src).toContain(
      's.suggestion?.email ? { customName: s.name, email: s.suggestion.email } : { customName: s.name }'
    );
  });

  test('the marker reads the CONFIRMED label only', () => {
    expect(src).toContain("s.status === 'confirmed'");
    expect(src).toContain('speakerLabels.find((l) => l.originalSpeaker === s.speaker)?.email ?? null');
    expect(src).toContain('data-speaker-email={labelEmail}');
  });
});

describe('"+ Person" dialog — the invitee email prefill', () => {
  const src = read('components/add-person-dialog.tsx');

  test('opens with initialEmail (still editable), reset on every open', () => {
    expect(src).toContain('initialEmail?: string | null;');
    expect(src).toContain("useState(initialEmail ?? '')");
    expect(src).toContain("setEmail(initialEmail ?? '');");
    expect(src).toContain('}, [open, initialName, initialEmail]);');
  });

  test('"From the invite" shows only while the field still holds the prefill', () => {
    expect(src).toContain('{initialEmail && email === initialEmail && (');
    expect(src).toContain('From the invite');
  });
});

describe('detail page — saves carry the email by the rules', () => {
  const src = read('app/transcript/[id]/page.tsx');

  test('handleSaveSpeaker: patch email, else the existing one only for the same name', () => {
    expect(src).toContain('patch: { customName?: string; description?: string; email?: string }');
    expect(src).toContain(
      '(existing?.email && sameSpeakerName(existing.customName, customName) ? existing.email : undefined);'
    );
    expect(src).toContain('...(email ? { email } : {}),');
  });

  test('"+ Person" saves the created person\'s email; "Use as label only" the name only', () => {
    expect(src).toContain(
      'handleSaveSpeaker(original, { customName: person.name, ...(person.email ? { email: person.email } : {}) });'
    );
    expect(src).toContain('handleSaveSpeaker(original, { customName: name });');
  });

  test('review confirm attaches the suggestion email only when the name is the suggested one', () => {
    expect(src).toContain('suggestion?.email && sameSpeakerName(suggestion.name, name) ? suggestion.email : undefined;');
  });

  test('the dialog prefill is the one invitee the pending name matches', () => {
    expect(src).toContain(
      'pendingCreate ? matchEmailByName(pendingCreate.name, inviteeCandidates(row?.gmeet_context?.attendees)) : null'
    );
  });
});
