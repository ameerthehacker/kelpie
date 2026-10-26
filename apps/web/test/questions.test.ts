import { describe, expect, it } from 'vitest';
import type { Question } from '@kelpie/protocol';
import { clearDrafts, draftKey, getDrafts, setDrafts, subscribeDrafts } from '../src/lib/question-drafts.js';
import { answered, answersOf, canSubmit, chosen, emptyDraft, isPicked, nextUnanswered, numberProblem, otherIndex, pick, questionsLine } from '../src/lib/questions.js';

const color: Question = { question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] };
const extras: Question = { question: 'Which extras?', options: [{ label: 'Tests' }, { label: 'Docs' }, { label: 'Lint' }], multiSelect: true };
const name: Question = { question: 'Name?', kind: 'text', options: [] };
const slides: Question = { question: 'Slides?', kind: 'number', min: 3, max: 20, defaultValue: 8, unit: 'slides', options: [] };

describe('answering questions', () => {
  it('picks one option at a time, or "Other" in its place', () => {
    let d = pick(color, emptyDraft(), 0);
    expect(d.picked).toEqual([0]);
    d = pick(color, d, 1);
    expect(d.picked).toEqual([1]);
    d = pick(color, d, otherIndex(color));
    expect(d).toMatchObject({ picked: [], other: true });
    // Other counts only once something is written in it.
    expect(answered(color, d)).toBe(false);
    expect(answersOf([color], [{ ...d, text: '  Green ' }])).toEqual({ 'Which color?': 'Green' });
    expect(pick(color, d, 7)).toBe(d);
  });

  it('toggles any number of options, and their own answer too, for a multi-select question', () => {
    let d = pick(extras, emptyDraft(), 2);
    d = pick(extras, d, 0);
    expect(d.picked).toEqual([0, 2]);
    d = pick(extras, d, 2);
    expect(d.picked).toEqual([0]);
    d = pick(extras, { ...d, text: 'Benchmarks' }, otherIndex(extras));
    expect(isPicked(extras, d, otherIndex(extras))).toBe(true);
    expect(answersOf([extras], [d])).toEqual({ 'Which extras?': ['Tests', 'Benchmarks'] });
  });

  it('sends only the questions answered, by their text', () => {
    expect(answersOf([color, extras], [pick(color, emptyDraft(), 1), emptyDraft()])).toEqual({ 'Which color?': 'Blue' });
  });

  it('reads back what was answered, and says what a queue row asks', () => {
    expect(chosen({ 'Which color?': 'Blue', 'Which extras?': ['Tests', 'Docs'] }, extras)).toEqual(['Tests', 'Docs']);
    expect(chosen({ 'Which color?': 'Blue' }, color)).toEqual(['Blue']);
    expect(chosen(undefined, color)).toEqual([]);
    expect(questionsLine([color])).toBe('Which color?');
    expect(questionsLine([color, extras])).toBe('2 questions: Color, Question 2');
  });

  it('takes a text question in words and a number question in range, starting at its default', () => {
    expect(emptyDraft(slides).text).toBe('8');
    expect(emptyDraft(name).text).toBe('');
    // They have no options to pick.
    expect(pick(name, emptyDraft(name), 0)).toEqual(emptyDraft(name));
    expect(answersOf([name, slides], [{ ...emptyDraft(), text: ' Kelp ' }, emptyDraft(slides)])).toEqual({ 'Name?': 'Kelp', 'Slides?': '8' });
    expect(numberProblem(slides, '30')).toBe('A number from 3 to 20');
    expect(numberProblem(slides, 'ten')).toBe('A number from 3 to 20');
    expect(numberProblem(slides, '')).toBeUndefined();
    expect(numberProblem(name, 'ten')).toBeUndefined();
    expect(answered(slides, { ...emptyDraft(), text: '30' })).toBe(false);
    expect(chosen({ 'Slides?': '12' }, slides)).toEqual(['12 slides']);
  });

  it('submits with some questions unanswered, but not none, and not with a number out of range', () => {
    const none = [emptyDraft(), emptyDraft(), emptyDraft()];
    expect(canSubmit([color, extras, name], none)).toBe(false);
    expect(canSubmit([color, extras, name], [pick(color, emptyDraft(), 0), emptyDraft(), emptyDraft()])).toBe(true);
    expect(canSubmit([color, slides], [pick(color, emptyDraft(), 0), { ...emptyDraft(), text: '99' }])).toBe(false);
    // Enter goes on to the next question still unanswered after this one, and submits after the last.
    const ds = [emptyDraft(), pick(extras, emptyDraft(), 0), emptyDraft()];
    expect(nextUnanswered([color, extras, name], ds, 0)).toBe(2);
    expect(nextUnanswered([color, extras, name], ds, 2)).toBe(-1);
  });
});

describe('question drafts', () => {
  it('are one per question, for every card showing it, until it is answered', () => {
    const key = draftKey('s', 'r');
    let calls = 0;
    const stop = subscribeDrafts(() => calls++);
    expect(getDrafts(key)).toBeUndefined();
    const ds = [pick(color, emptyDraft(), 1)];
    setDrafts(key, ds);
    expect(getDrafts(key)).toBe(ds);
    expect(getDrafts(draftKey('s', 'other'))).toBeUndefined();
    clearDrafts(key);
    clearDrafts(key);
    expect(getDrafts(key)).toBeUndefined();
    expect(calls).toBe(2);
    stop();
    setDrafts(key, ds);
    expect(calls).toBe(2);
    clearDrafts(key);
  });
});
