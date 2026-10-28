import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactKey, type ArtifactDocumentBody, type Artifacts, type KelpieEvent } from '@kelpie/protocol';
import type { ManagerUpdate } from '../src/sessions.js';
import { openStore } from '@kelpie/store';
import { createApp, documentTitle, Orchestrator, SessionManager } from '../src/index.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const LOCAL = { host: '127.0.0.1:7317', 'content-type': 'application/json' };

/** A round-up with one agent and a scratch folder; nothing is started. */
function setup() {
  const store = openStore(':memory:');
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp' });
  const sessions = new SessionManager({ store, defaultCwd: tmpdir(), runsDir: tmp('kelpie-runs-'), scratchDir: tmp('kelpie-scratch-'), hooks: orch });
  orch.attach(sessions);
  const roundUp = sessions.create(tmpdir(), { role: 'orchestrator' });
  const agent = sessions.create(tmpdir(), { parentId: roundUp.id, role: 'agent', writes: true, title: 'Schema migration' });
  const scratch = roundUp.scratch!;
  mkdirSync(scratch, { recursive: true });
  let idx = 0;
  /** A `file.changed` in a session's log, as the adapter would have written it. */
  const wrote = (sessionId: string, path: string, ts: string) =>
    store.appendEvent(sessionId, idx++, {
      id: `e${idx}`,
      runId: 'run',
      seq: idx,
      ts,
      harness: 'claude-code',
      kind: 'file.changed',
      data: { callId: `c${idx}`, path, op: 'write', added: 1, removed: 0 },
    } as KelpieEvent);
  const app = createApp(sessions, { orchestrator: orch });
  const get = async <T>(path: string) => {
    const res = await app.request(path, { headers: { host: LOCAL.host } });
    return { status: res.status, body: (await res.json()) as T };
  };
  const accept = (body: { key: string; seen?: number }) => app.request(`/api/sessions/${roundUp.id}/artifacts/accept`, { method: 'POST', headers: LOCAL, body: JSON.stringify(body) });
  return { store, orch, sessions, roundUp, agent, scratch, wrote, app, get, accept };
}

describe('documentTitle', () => {
  it("takes the first heading, else the file's name", () => {
    expect(documentTitle('intro\n\n## Migration notes ##\n# Later', 'a/notes.md')).toBe('Migration notes');
    expect(documentTitle('no heading here', 'db/README.md')).toBe('README');
    expect(documentTitle('#not-a-heading', 'plan.markdown')).toBe('plan');
  });
});

describe('artifacts API', () => {
  it("lists the scratch folder's Markdown files, newest first, each credited to whoever last wrote it", async () => {
    const { roundUp, agent, scratch, wrote, get } = setup();
    mkdirSync(join(scratch, 'notes'));
    mkdirSync(join(scratch, 'uploads'));
    writeFileSync(join(scratch, 'notes', 'migration.md'), '# Migration notes\n\nGuest orders get their own table.');
    writeFileSync(join(scratch, 'design-spec.md'), '# Design spec');
    writeFileSync(join(scratch, 'shell.md'), 'written from a shell');
    writeFileSync(join(scratch, 'uploads', 'mine.md'), '# the person uploaded this');
    writeFileSync(join(scratch, 'data.json'), '{}');
    utimesSync(join(scratch, 'design-spec.md'), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(scratch, 'shell.md'), new Date(2_000_000), new Date(2_000_000));
    wrote(roundUp.id, join(scratch, 'design-spec.md'), '2026-10-28T10:00:00.000Z');
    wrote(roundUp.id, join(scratch, 'notes', 'migration.md'), '2026-10-28T10:01:00.000Z');
    // The agent rewrote it after Kelpie: it is the agent's.
    wrote(agent.id, join(scratch, 'notes', 'migration.md'), '2026-10-28T10:02:00.000Z');
    // A write outside the scratch folder is not a document.
    wrote(agent.id, '/elsewhere/README.md', '2026-10-28T10:03:00.000Z');

    const { status, body } = await get<Artifacts>(`/api/sessions/${roundUp.id}/artifacts`);
    expect(status).toBe(200);
    expect(body.documents.map((d) => [d.path, d.title, d.author?.title])).toEqual([
      ['notes/migration.md', 'Migration notes', 'Schema migration'],
      ['shell.md', 'shell', undefined],
      ['design-spec.md', 'Design spec', 'Kelpie'],
    ]);
    expect(body.documents[0]!.author).toEqual({ kind: 'agent', agentId: agent.id, title: 'Schema migration', harness: 'claude-code' });
    expect(body.documents[2]!.author).toMatchObject({ kind: 'orchestrator' });
    // An agent's id answers for its round-up.
    expect((await get<Artifacts>(`/api/sessions/${agent.id}/artifacts`)).body.documents).toHaveLength(3);
    expect((await get('/api/sessions/nope/artifacts')).status).toBe(404);
  });

  it('serves one document, and nothing outside the scratch folder or that is not Markdown', async () => {
    const { roundUp, scratch, get } = setup();
    writeFileSync(join(scratch, 'notes.md'), '# Notes\n\n- one');
    writeFileSync(join(scratch, 'secret.txt'), 'no');
    const outside = join(tmp('kelpie-outside-'), 'out.md');
    writeFileSync(outside, '# outside');
    symlinkSync(outside, join(scratch, 'link.md'));

    const doc = await get<ArtifactDocumentBody>(`/api/sessions/${roundUp.id}/artifacts/document?path=notes.md`);
    expect(doc.status).toBe(200);
    expect(doc.body).toMatchObject({ path: 'notes.md', title: 'Notes', text: '# Notes\n\n- one' });
    expect((await get(`/api/sessions/${roundUp.id}/artifacts/document?path=../x.md`)).status).toBe(400);
    expect((await get(`/api/sessions/${roundUp.id}/artifacts/document?path=secret.txt`)).status).toBe(400);
    expect((await get(`/api/sessions/${roundUp.id}/artifacts/document?path=link.md`)).status).toBe(404);
    expect((await get(`/api/sessions/${roundUp.id}/artifacts/document?path=gone.md`)).status).toBe(404);
    expect((await get(`/api/sessions/${roundUp.id}/artifacts/document`)).status).toBe(400);
  });

  it('records an Accept, until the document changes again', async () => {
    const { roundUp, scratch, get, accept } = setup();
    const file = join(scratch, 'notes.md');
    writeFileSync(file, '# Notes');
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));

    const res = await accept({ key: artifactKey({ kind: 'document', path: 'notes.md' }), seen: 1_000_000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Artifacts;
    expect(body.documents[0]!.acceptedAt).toBeGreaterThan(0);
    expect(Object.keys(body.accepted)).toEqual(['doc:notes.md']);
    expect((await accept({ key: artifactKey({ kind: 'changes', agentId: 'a1' }, 'abc1234') })).status).toBe(200);
    expect((await accept({ key: 'changes:a1@' })).status).toBe(400);
    expect((await accept({ key: 'anything' })).status).toBe(400);
    // A document's Accept says which version the person saw.
    expect((await accept({ key: 'doc:notes.md' })).status).toBe(400);
    expect((await accept({ key: 'doc:gone.md', seen: 1 })).status).toBe(404);

    // Written after the Accept: ready for review again.
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    const after = (await get<Artifacts>(`/api/sessions/${roundUp.id}/artifacts`)).body;
    expect(after.documents[0]!.acceptedAt).toBeUndefined();
    expect(after.accepted['changes:a1@abc1234']).toBeGreaterThan(0);
  });

  it('lists nothing for a round-up without a scratch folder', async () => {
    const store = openStore(':memory:');
    const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp' });
    const sessions = new SessionManager({ store, defaultCwd: tmpdir(), runsDir: tmp('kelpie-runs-'), hooks: orch });
    orch.attach(sessions);
    const roundUp = sessions.create(tmpdir(), { role: 'orchestrator' });
    const res = await createApp(sessions, { orchestrator: orch }).request(`/api/sessions/${roundUp.id}/artifacts`, { headers: { host: LOCAL.host } });
    expect(await res.json()).toEqual({ documents: [], accepted: {}, heads: {} });
  });

  it('refuses an Accept of a document rewritten since the person loaded it', async () => {
    const { roundUp, scratch, get, accept } = setup();
    const file = join(scratch, 'notes.md');
    writeFileSync(file, '# Notes');
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));
    const seen = (await get<ArtifactDocumentBody>(`/api/sessions/${roundUp.id}/artifacts/document?path=notes.md`)).body.updatedAt;
    // The agent rewrites it while the person reads.
    writeFileSync(file, '# Notes, again');
    utimesSync(file, new Date(2_000_000), new Date(2_000_000));

    const res = await accept({ key: 'doc:notes.md', seen });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/changed since you opened it/);
    expect((await get<Artifacts>(`/api/sessions/${roundUp.id}/artifacts`)).body.accepted).toEqual({});
    // Accepted as it is now, it holds.
    expect((await accept({ key: 'doc:notes.md', seen: 2_000_000 })).status).toBe(200);
  });

  it("refuses an Accept of an agent's changes while it is still working on them", async () => {
    const { agent, accept } = setup();
    let working = true;
    Object.defineProperty(agent, 'working', { get: () => working });
    expect((await accept({ key: artifactKey({ kind: 'changes', agentId: agent.id }, 'abc1234') })).status).toBe(409);
    working = false;
    expect((await accept({ key: artifactKey({ kind: 'changes', agentId: agent.id }, 'abc1234') })).status).toBe(200);
  });

  it('serves no hard link, nor anything but a regular file', async () => {
    const { roundUp, scratch, get } = setup();
    const outside = join(tmp('kelpie-outside-'), 'secret.md');
    writeFileSync(outside, '# secret');
    // A hard link has no path outside the folder for realpath to catch: its link count gives it away.
    linkSync(outside, join(scratch, 'hard.md'));
    mkdirSync(join(scratch, 'dir.md'));
    expect((await get(`/api/sessions/${roundUp.id}/artifacts/document?path=hard.md`)).status).toBe(404);
    expect((await get(`/api/sessions/${roundUp.id}/artifacts/document?path=dir.md`)).status).toBe(404);
  });

  it('walks past hidden folders, node_modules and uploads, and keeps the newest 200', async () => {
    const { roundUp, scratch, get } = setup();
    for (const dir of ['.git', 'node_modules/pkg', 'uploads', 'notes/.cache']) {
      mkdirSync(join(scratch, dir), { recursive: true });
      writeFileSync(join(scratch, dir, 'README.md'), '# not a document');
    }
    mkdirSync(join(scratch, 'notes'), { recursive: true });
    for (let i = 0; i < 205; i++) {
      const file = join(scratch, 'notes', `n${String(i).padStart(3, '0')}.md`);
      writeFileSync(file, `# Note ${i}`);
      utimesSync(file, new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000));
    }
    const { documents } = (await get<Artifacts>(`/api/sessions/${roundUp.id}/artifacts`)).body;
    expect(documents).toHaveLength(200);
    expect(documents[0]).toMatchObject({ path: join('notes', 'n204.md'), title: 'Note 204' });
    expect(documents.at(-1)!.path).toBe(join('notes', 'n005.md'));
    expect(documents.every((d) => d.path.startsWith('notes/n'))).toBe(true);
  });

  it('credits a document to whoever wrote it last, the one logged last of writes at the same time', async () => {
    const { store, roundUp, agent, scratch, wrote } = setup();
    const file = join(scratch, 'plan.md');
    wrote(agent.id, file, '2026-10-28T10:00:00.000Z');
    wrote(roundUp.id, file, '2026-10-28T10:00:00.000Z');
    // Not Markdown: never read.
    wrote(agent.id, join(scratch, 'data.json'), '2026-10-28T10:00:00.000Z');
    expect(store.lastWritesUnder([roundUp.id, agent.id], scratch, ['.md'])).toEqual([{ path: file, sessionId: roundUp.id, ts: '2026-10-28T10:00:00.000Z' }]);
    wrote(agent.id, file, '2026-10-28T10:00:00.000Z');
    expect(store.lastWritesUnder([roundUp.id, agent.id], scratch, ['.md'])[0]!.sessionId).toBe(agent.id);
    // An earlier write logged later doesn't win.
    wrote(roundUp.id, file, '2026-10-28T09:00:00.000Z');
    expect(store.lastWritesUnder([roundUp.id, agent.id], scratch, ['.md'])[0]!.sessionId).toBe(agent.id);
    expect(store.lastWritesUnder([roundUp.id, agent.id], scratch)).toHaveLength(2);
  });

  it('tells the event stream when a document in the scratch folder is written', () => {
    const { orch, sessions, roundUp, agent, scratch } = setup();
    const seen: ManagerUpdate[] = [];
    const stop = sessions.watch((u) => u.type === 'artifacts' && seen.push(u));
    const changed = (path: string) =>
      ({ id: 'e', runId: 'run', seq: 1, ts: '2026-10-28T10:00:00.000Z', harness: 'claude-code', kind: 'file.changed', data: { callId: 'c', path, op: 'write', added: 1, removed: 0 } }) as KelpieEvent;
    orch.observe(agent, 0, changed(join(scratch, 'notes', 'plan.md')));
    orch.observe(roundUp, 0, changed(join(scratch, 'spec.md')));
    orch.observe(agent, 1, changed(join(scratch, 'data.json')));
    orch.observe(agent, 2, changed('/elsewhere/README.md'));
    stop();
    expect(seen).toEqual([
      { type: 'artifacts', roundUpId: roundUp.id, path: join('notes', 'plan.md') },
      { type: 'artifacts', roundUpId: roundUp.id, path: 'spec.md' },
    ]);
  });

  it("gives each writer agent's commit now, for whether an Accept of its changes still holds", async () => {
    const { store, roundUp, agent, get } = setup();
    const repo = tmp('kelpie-repo-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('branch', 'kelpie/agent-1');
    store.createWorktree({ roundUpId: roundUp.id, sessionId: agent.id, kind: 'agent', repoRoot: repo, path: join(repo, '..', 'wt'), branch: 'kelpie/agent-1', parentBranch: 'main', baseBranch: 'main', baseCommit: base });
    expect((await get<Artifacts>(`/api/sessions/${roundUp.id}/artifacts`)).body.heads).toEqual({ [agent.id]: base });
  });
});
