import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { openStore } from '@kelpie/store';
import { SessionManager, type Session } from '../src/index.js';
import { waitFor } from './review-fixtures.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
chmodSync(FAKE, 0o755);
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
/** The real CLI's `/context`, which it never replays: its output, then a result naming the command. */
const LOCAL = readFileSync(join(import.meta.dirname, '../../adapters/fixtures/claude-code/local-commands.jsonl'), 'utf8').split('\n').slice(0, 3).join('\n');

function until(session: Session, kind: KelpieEvent['kind']): Promise<KelpieEvent[]> {
  return new Promise((resolve) => {
    const log: KelpieEvent[] = [];
    const stop = session.subscribe(({ index, event }) => {
      log[index] = event;
      if (event.kind === kind) {
        queueMicrotask(() => stop());
        resolve(log);
      }
    });
  });
}

describe('a local slash command', () => {
  it('is delivered, shows as typed, and leaves the round-up idle, though the CLI never echoes it', async () => {
    const fixture = join(tmp('kelpie-fixture-'), 'local.jsonl');
    writeFileSync(fixture, LOCAL + '\n');
    const store = openStore(':memory:');
    const sessions = new SessionManager({ store, defaultCwd: tmpdir(), runsDir: tmp('kelpie-runs-'), defaults: { bin: FAKE, env: { FAKE_FIXTURE: fixture } } });
    const s = sessions.create();
    const ended = until(s, 'turn.ended');
    await s.send('/context');
    const log = await ended;
    const user = log.filter((e) => e?.kind === 'message' && e.data.role === 'user');
    expect(user.map((e) => e.kind === 'message' && { text: e.data.text, sent: e.data.sent, source: (e.data as { source?: string }).source })).toEqual([
      { text: '/context', sent: true, source: 'user' },
    ]);
    // Before its output, as with any turn.
    expect(log.findIndex((e) => e === user[0])).toBeLessThan(log.findIndex((e) => e?.kind === 'message' && e.data.role === 'assistant'));
    expect(store.undelivered(s.id)).toEqual([]);
    // Its `activity` comes just after the turn ends; without the turn taken in, it would never come.
    await waitFor(() => !s.info().busy, 2000);
  });
});
