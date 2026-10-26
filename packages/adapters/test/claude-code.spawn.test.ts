import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Effort, KelpieEvent } from '@kelpie/protocol';
import { claudeArgs, claudeCode, type RunSpec } from '../src/index.js';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const FIXTURES = join(import.meta.dirname, '../fixtures/claude-code');

beforeAll(() => chmodSync(FAKE, 0o755));

function start(fixture: string, extra: Partial<RunSpec> & { hang?: boolean } = {}) {
  const { hang, ...spec } = extra;
  return claudeCode.start({
    cwd: tmpdir(),
    bin: FAKE,
    runDir: mkdtempSync(join(tmpdir(), 'kelpie-run-')),
    env: { FAKE_FIXTURE: join(FIXTURES, `${fixture}.jsonl`), FAKE_HANG: hang ? '1' : '0' },
    ...spec,
  });
}

async function collect(run: ReturnType<typeof start>, onEvent?: (e: KelpieEvent) => void | Promise<void>) {
  const events: KelpieEvent[] = [];
  for await (const e of run.events) {
    events.push(e);
    await onEvent?.(e);
  }
  return events;
}

describe('claude-code spawn', () => {
  it('runs a turn end to end and tees the raw stream', async () => {
    const run = start('plain', { prompt: 'What is 2+2?' });
    expect(run.busy).toBe(true);
    const events = await collect(run, async (e) => {
      if (e.kind === 'turn.ended') {
        expect(run.busy).toBe(false);
        await run.stop();
      }
    });
    expect(events.map((e) => e.kind)).toEqual([
      'activity', 'session.started', 'message', 'message', 'rate_limit', 'usage', 'turn.ended', 'activity', 'process.exited',
    ]);
    events.forEach((e) => expect(KelpieEvent.safeParse(e).error).toBeUndefined());
    expect(run.harnessSessionId).toBeTruthy();

    const raw = readFileSync(join(run.runDir, 'raw.jsonl'), 'utf8').split('\n').filter(Boolean);
    const turnEnded = events.find((e) => e.kind === 'turn.ended')!;
    expect(JSON.parse(raw[turnEnded.rawLine! - 1]!).type).toBe('result');
  });

  it('stays busy until queued turns are taken in, even when they merge into one result', async () => {
    const run = start('queued');
    run.send('first');
    run.send('second');
    run.send('third');
    const ends: boolean[] = [];
    const events = await collect(run, async (e) => {
      if (e.kind === 'turn.ended') {
        ends.push(run.busy);
        await run.stop();
      }
    });
    expect(ends).toEqual([false]);
    expect(events.filter((e) => e.kind === 'message' && e.data.role === 'user')).toHaveLength(3);
  });

  it('refuses to reuse a run directory', async () => {
    const run = start('plain', { prompt: 'hi' });
    await collect(run, (e) => void (e.kind === 'turn.ended' && run.stop()));
    expect(() => start('plain', { runDir: run.runDir })).toThrow(/already holds a run/);
  });

  it('rejects sends after stop', async () => {
    const run = start('plain');
    const stopped = run.stop();
    expect(() => run.send('late')).toThrow(/stopping|exited/);
    await stopped;
    expect(run.exited).toBe(true);
  });

  it('kills a harness that ignores an interrupt, and reports the turn as interrupted', { timeout: 15_000 }, async () => {
    const run = start('plain', { prompt: 'hang', hang: true });
    const events = await collect(run, async (e) => {
      if (e.kind === 'session.started') await run.interrupt();
    });
    const kinds = events.map((e) => e.kind);
    expect(kinds.slice(-3)).toEqual(['turn.ended', 'activity', 'process.exited']);
    expect(events.at(-3)!.data).toMatchObject({ status: 'interrupted' });
    expect(events.at(-2)!.data).toEqual({ busy: false });
  });
});

describe('MCP config', () => {
  it('reaches the harness in a file only the person can read, never in argv, and goes when it exits', async () => {
    const rawArgs = join(mkdtempSync(join(tmpdir(), 'kelpie-raw-')), 'args.jsonl');
    const config = JSON.stringify({ mcpServers: { kelpie: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer s3cret' } } } });
    const run = start('plain', { prompt: 'hi', hang: true, mcpConfig: [config], env: { FAKE_FIXTURE: join(FIXTURES, 'plain.jsonl'), FAKE_HANG: '1', FAKE_RAW_ARGS_FILE: rawArgs } });
    const events = collect(run);
    let argv: string[] | undefined;
    for (let i = 0; i < 200 && !argv; i++) {
      if (existsSync(rawArgs)) argv = JSON.parse(readFileSync(rawArgs, 'utf8').split('\n')[0]!);
      else await new Promise((r) => setTimeout(r, 20));
    }
    const path = argv![argv!.indexOf('--mcp-config') + 1]!;
    expect(argv!.join(' ')).not.toContain('s3cret');
    expect(readFileSync(join(run.runDir, 'run.json'), 'utf8')).not.toContain('s3cret');
    expect(readFileSync(path, 'utf8')).toBe(config);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    await run.stop();
    await events;
    expect(existsSync(path)).toBe(false);
  });

  it('changes a live process’s effort with a control request', async () => {
    const controls = join(mkdtempSync(join(tmpdir(), 'kelpie-controls-')), 'controls.jsonl');
    const run = start('plain', { env: { FAKE_FIXTURE: join(FIXTURES, 'plain.jsonl'), FAKE_CONTROL_FILE: controls } });
    const events = collect(run);
    expect(await run.setEffort('xhigh')).toBe(true);
    expect(readFileSync(controls, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh' } },
    ]);
    await run.stop();
    await events;
    expect(await run.setEffort('low')).toBe(false);
  });

  it('passes a config path through as it is', () => {
    expect(claudeArgs({ cwd: '/r', mcpConfig: ['/etc/kelpie/mcp.json'] })).toEqual(expect.arrayContaining(['--mcp-config', '/etc/kelpie/mcp.json']));
  });
});

describe('claudeArgs', () => {
  const spec: RunSpec = { cwd: '/work/repo', prompt: 'hi' };

  it('passes the effort level when there is one, and leaves the harness default alone otherwise', () => {
    for (const effort of Effort.options) {
      const args = claudeArgs({ ...spec, effort });
      expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', effort]);
    }
    expect(claudeArgs(spec)).not.toContain('--effort');
    // A resume keeps it: every start passes it again.
    expect(claudeArgs({ ...spec, resume: 'h', effort: 'max' })).toEqual(expect.arrayContaining(['--resume', 'h', '--effort', 'max']));
  });

  it('turns Claude in Chrome off unless the run asks for the browser', () => {
    // Off explicitly, so the person's "enabled by default" setting doesn't hand it to every agent.
    for (const s of [spec, { ...spec, browser: false }]) {
      expect(claudeArgs(s)).toContain('--no-chrome');
      expect(claudeArgs(s)).not.toContain('--chrome');
    }
    const on = claudeArgs({ ...spec, browser: true });
    expect(on).toContain('--chrome');
    expect(on).not.toContain('--no-chrome');
    // Its tools come with the flag, not from an allow rule.
    expect(on).not.toContain('--allowedTools');
  });
});
