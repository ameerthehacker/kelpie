import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactKey, type ArtifactDocumentBody, type Artifacts, type KelpieEvent } from '@kelpie/protocol';
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
  return { store, sessions, roundUp, agent, scratch, wrote, app, get };
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
    const { roundUp, scratch, app, get } = setup();
    const file = join(scratch, 'notes.md');
    writeFileSync(file, '# Notes');
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));
    const accept = (key: string) => app.request(`/api/sessions/${roundUp.id}/artifacts/accept`, { method: 'POST', headers: LOCAL, body: JSON.stringify({ key }) });

    const res = await accept(artifactKey({ kind: 'document', path: 'notes.md' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Artifacts;
    expect(body.documents[0]!.acceptedAt).toBeGreaterThan(0);
    expect(Object.keys(body.accepted)).toEqual(['doc:notes.md']);
    expect((await accept(artifactKey({ kind: 'changes', agentId: 'a1' }, 'abc1234'))).status).toBe(200);
    expect((await accept('changes:a1@')).status).toBe(400);
    expect((await accept('anything')).status).toBe(400);

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
    expect(await res.json()).toEqual({ documents: [], accepted: {} });
  });
});
