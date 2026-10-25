import { describe, expect, it } from 'vitest';
import type { Question } from '@kelpie/protocol';
import { answered, answersOf, chosen, emptyDraft, isPicked, otherIndex, pick, questionsLine } from '../src/lib/questions.js';

const color: Question = { question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] };
const extras: Question = { question: 'Which extras?', options: [{ label: 'Tests' }, { label: 'Docs' }, { label: 'Lint' }], multiSelect: true };

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
});
