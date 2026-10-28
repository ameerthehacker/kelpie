import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '@kelpie/protocol';
import { agentMention, applySuggestion, fileMention, rankCommands, rankTitled, triggerAt } from '../src/lib/suggestions.js';

/** `text` with `|` marking the caret. */
const at = (marked: string) => triggerAt(marked.replace('|', ''), marked.indexOf('|'));

describe('the composer trigger', () => {
  it('opens commands for a slash at the start of the message, after any leading space', () => {
    expect(at('/|')).toEqual({ kind: '/', start: 0, query: '' });
    expect(at('/comp|')).toEqual({ kind: '/', start: 0, query: 'comp' });
    expect(at('  \n/front:co|')).toEqual({ kind: '/', start: 3, query: 'front:co' });
    // The caret inside the word: what's before it is the query.
    expect(at('/comp|act')).toEqual({ kind: '/', start: 0, query: 'comp' });
  });

  it('leaves a slash anywhere else alone, and closes once the command has its arguments', () => {
    expect(at('see src/|')).toBeUndefined();
    expect(at('fix this /|')).toBeUndefined();
    expect(at('/compact |')).toBeUndefined();
    expect(at('/compact keep the plan|')).toBeUndefined();
    expect(at('|/compact')).toBeUndefined();
  });

  it('opens mentions for an @ starting a word, anywhere in the message', () => {
    expect(at('@|')).toEqual({ kind: '@', start: 0, query: '' });
    expect(at('look at @src/comp|')).toEqual({ kind: '@', start: 8, query: 'src/comp' });
    expect(at('first line\n@Check|')).toEqual({ kind: '@', start: 11, query: 'Check' });
    expect(at('(@READ|')).toEqual({ kind: '@', start: 1, query: 'READ' });
    // A command's argument can mention a file too.
    expect(at('/code-review @src|')).toEqual({ kind: '@', start: 13, query: 'src' });
  });

  it('leaves email addresses and finished mentions alone', () => {
    expect(at('mail me@example.com|')).toBeUndefined();
    expect(at('a@|')).toBeUndefined();
    expect(at('@src/app.ts |')).toBeUndefined();
    expect(at('no trigger|')).toBeUndefined();
    expect(at('|')).toBeUndefined();
  });
});

describe('putting a suggestion in', () => {
  it('replaces the whole word, past the caret too, and leaves the caret after a space', () => {
    expect(applySuggestion('/comp', { kind: '/', start: 0, query: 'comp' }, '/compact')).toEqual({ text: '/compact ', caret: 9 });
    expect(applySuggestion('/compxx tail', { kind: '/', start: 0, query: 'comp' }, '/compact')).toEqual({ text: '/compact tail', caret: 9 });
    const text = 'look at @src/co and then';
    expect(applySuggestion(text, { kind: '@', start: 8, query: 'src/co' }, '@src/components/chat/composer.tsx')).toEqual({
      text: 'look at @src/components/chat/composer.tsx and then',
      caret: 42,
    });
  });

  it('mentions files by path (quoted with a space in it) and agents by title', () => {
    expect(fileMention('apps/web/src/App.tsx')).toBe('@apps/web/src/App.tsx');
    expect(fileMention('docs/My Notes.md')).toBe('@"docs/My Notes.md"');
    expect(agentMention('Checkout API')).toBe('@Checkout API');
  });
});

describe('ranking suggestions', () => {
  const command = (name: string, aliases: string[] = []): SlashCommand => ({ name, description: '', argumentHint: '', aliases, source: 'built-in' });
  const commands = [command('compact'), command('context'), command('code-review', ['review']), command('security-review'), command('front:component')];

  it('lists every command, in order, before anything is typed; then the best matches first', () => {
    expect(rankCommands(commands, '').map((c) => c.name)).toEqual(commands.map((c) => c.name));
    expect(rankCommands(commands, 'comp')[0]!.name).toBe('compact');
    expect(rankCommands(commands, 'fcomp').map((c) => c.name)).toEqual(['front:component']);
    expect(rankCommands(commands, 'zzz')).toEqual([]);
  });

  it('matches aliases, and caps the list', () => {
    expect(rankCommands(commands, 'review').map((c) => c.name)).toContain('code-review');
    expect(rankCommands(commands, '', 2)).toHaveLength(2);
  });

  it('matches agents by title', () => {
    const agents = [{ title: 'Checkout API' }, { title: 'RCA ticket 4512' }, { title: 'Composer / and @ suggestions' }];
    expect(rankTitled(agents, 'chk').map((a) => a.title)).toEqual(['Checkout API']);
    expect(rankTitled(agents, 'compo').map((a) => a.title)).toEqual(['Composer / and @ suggestions']);
    expect(rankTitled(agents, '')).toHaveLength(3);
  });
});
