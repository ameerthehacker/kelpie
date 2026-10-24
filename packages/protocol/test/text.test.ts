import { describe, expect, it } from 'vitest';
import { firstLine } from '../src/index.js';

describe('firstLine', () => {
  it('takes the first line that is not a heading, without emphasis or code ticks', () => {
    expect(firstLine('## Outcome\n\n**done**: fixed `parse_args` in *cli.ts*')).toBe('done: fixed parse_args in cli.ts');
  });

  it('leaves identifiers with underscores alone', () => {
    expect(firstLine('renamed snake_case_name and max_retry_count')).toBe('renamed snake_case_name and max_retry_count');
  });

  it('collapses whitespace and cuts to a length', () => {
    expect(firstLine('a   b\tc')).toBe('a b c');
    expect(firstLine('abcdefghij', 5)).toBe('abcd…');
    expect(firstLine('')).toBe('');
  });
});
