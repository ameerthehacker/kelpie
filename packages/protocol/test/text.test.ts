import { describe, expect, it } from 'vitest';
import { attachmentsBlock, firstLine, stripAttachments } from '../src/index.js';

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

describe('attachments', () => {
  it('lists files by path and strips the block back off', () => {
    const block = attachmentsBlock([
      { path: '/s/uploads/a-shot.png', mime: 'image/png', size: 2048 },
      { path: '/s/notes.md', size: 12 },
    ]);
    expect(block).toBe('<attachments>\n- /s/uploads/a-shot.png (image/png, 2 KB)\n- /s/notes.md (file, 12 B)\n</attachments>');
    expect(stripAttachments(`Why does this fail?\n\n${block}`)).toBe('Why does this fail?');
    expect(stripAttachments(block)).toBe('');
    expect(stripAttachments('no files here')).toBe('no files here');
  });
});
