/**
 * Records real `claude -p` stream-json output into adapter fixtures.
 *
 *   pnpm capture:claude [scenario...]      # default: all scenarios
 *
 * Launches the CLI with the adapter's own argv but reads its stdout directly
 * (not through the parser), so fixtures stay an independent record of what
 * the harness emits. Each scenario runs in its own throwaway git repo; temp
 * paths and $HOME are redacted so snapshots are stable across machines.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { claudeArgs, userTurn, type RunSpec } from '@kelpie/adapters';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../packages/adapters/fixtures/claude-code');
const MODEL = process.env.KELPIE_CAPTURE_MODEL ?? 'haiku';

type Obj = Record<string, any>;

interface Scenario {
  turns: string[];
  /** Session to resume; a function so it can depend on earlier scenarios. */
  resume?: () => string;
  /** Send an interrupt the first time this matches a stdout event. */
  interruptWhen?: (o: Obj) => boolean;
  /** Send all remaining turns at once, mid-turn, the first time this matches. */
  queueWhen?: (o: Obj) => boolean;
  /** Settings for this scenario beyond the defaults (e.g. no Bash allow, so the CLI asks). */
  spec?: Partial<RunSpec>;
  /** How to answer the CLI's permission requests (can_use_tool). */
  answer?: 'allow' | 'deny';
}

const usesTool = (name: string) => (o: Obj) =>
  o.type === 'assistant' && o.message?.content?.some((c: Obj) => c.type === 'tool_use' && c.name === name);

const sessions: Record<string, string> = {};

const SCENARIOS: Record<string, Scenario> = {
  plain: { turns: ['What is 2+2? Answer with just the number.'] },
  'read-search': {
    turns: ['Use Grep to find where `add` is defined, Read that file, then tell me its signature in one line.'],
  },
  'edit-bash': {
    turns: [
      'Add an exported `sub(a, b)` function to src/math.js using Edit, create test/sub.test.js (node:test + node:assert) with Write, then run `node --test` with Bash and report the result in one line.',
    ],
  },
  todos: {
    turns: [
      'Use TaskCreate to create two tasks: "Count lines" and "Report". Mark "Count lines" in_progress with TaskUpdate, run `wc -l src/math.js` with Bash, mark it completed, then mark "Report" in_progress, tell me the count, and mark "Report" completed.',
    ],
  },
  'bash-fail': {
    turns: ['Run exactly this with Bash: `node -e "process.exit(3)"`. Do not retry. Tell me the exit code.'],
  },
  subagent: {
    turns: [
      'Use the Task tool with subagent_type "general-purpose" to read src/math.js and report the exported function names. Do not read it yourself. Then repeat its answer in one line.',
    ],
  },
  'multi-turn': {
    turns: ['Remember the word "kelpie". Reply with just OK.', 'What word did I ask you to remember? Just the word.'],
  },
  resume: {
    turns: ['What word did I ask you to remember earlier in this conversation? Just the word.'],
    resume: () => {
      const id = sessions['multi-turn'];
      if (!id) throw new Error('resume needs the multi-turn scenario to run first');
      return id;
    },
  },
  interrupt: {
    turns: ['Run exactly `node -e "setTimeout(()=>{},30000)"` with Bash, then say done.'],
    interruptWhen: usesTool('Bash'),
  },
  // Messages sent mid-turn: the CLI may fold them into the running turn (fewer results than sends).
  queued: {
    turns: [
      'Run exactly `node -e "setTimeout(()=>{},4000)"` with Bash, then reply "first".',
      'Also reply with the word "second".',
      'And reply with the word "third".',
    ],
    queueWhen: usesTool('Bash'),
  },
  // The CLI asks before running a command its rules don't allow: answered yes, and no.
  permission: {
    turns: ['Run exactly `node -e "console.log(41+1)"` with Bash and tell me the output in one line.'],
    spec: { allowedTools: [] },
    answer: 'allow',
  },
  'permission-deny': {
    turns: ['Run exactly `node -e "console.log(41+1)"` with Bash. If it is refused, do not retry; say so in one line.'],
    spec: { allowedTools: [] },
    answer: 'deny',
  },
  // Plan mode: the plan is put to the person with ExitPlanMode.
  plan: {
    turns: ['Plan adding an exported sub(a, b) to src/math.js in two lines, then present it with ExitPlanMode. Do not change anything.'],
    spec: { permissionMode: 'plan', tools: ['Read', 'Glob', 'Write', 'ExitPlanMode'], allowedTools: [] },
    answer: 'allow',
  },
  // A background sub-agent: when it finishes, the CLI starts a turn by itself.
  'background-agent': {
    turns: [
      'Use the Agent tool with subagent_type "general-purpose" and run_in_background true, prompt: "Read src/math.js and reply with the exported function names." Do not wait for it or read the file yourself; end your turn right after launching it. When its report arrives, repeat it in one line.',
    ],
  },
};

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kelpie-fixture-')));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(dir, 'src/math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(
    join(dir, 'test/add.test.js'),
    "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/math.js';\n\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  );
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=k@k', '-c', 'user.name=k', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

async function capture(name: string, s: Scenario): Promise<void> {
  const cwd = makeRepo();
  const args = claudeArgs({ cwd, model: MODEL, allowedTools: ['Bash'], ...s.spec, ...(s.resume ? { resume: s.resume() } : {}) });
  const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  const turns = [...s.turns];
  let interrupted = false;
  child.stdin.write(userTurn(turns.shift()!));

  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    lines.push(line);
    const o = JSON.parse(line) as Obj;
    if (o.type === 'system' && o.subtype === 'init') sessions[name] = o.session_id;
    if (o.type === 'control_request' && o.request?.subtype === 'can_use_tool') {
      const response = s.answer === 'allow' ? { behavior: 'allow', updatedInput: o.request.input } : { behavior: 'deny', message: 'The person denied this.' };
      child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response } }) + '\n');
    }
    if (s.interruptWhen && !interrupted && s.interruptWhen(o)) {
      interrupted = true;
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'kelpie-int-1', request: { subtype: 'interrupt' } }) + '\n');
    }
    if (s.queueWhen && turns.length && s.queueWhen(o)) {
      for (const t of turns.splice(0)) child.stdin.write(userTurn(t));
    }
    if (o.type === 'result' && !child.stdin.writableEnded) {
      const next = turns.shift();
      // Ending stdin lets the CLI exit once idle; it still finishes queued turns and background agents first.
      if (next) child.stdin.write(userTurn(next));
      else child.stdin.end();
    }
  }
  const code = await new Promise<number | null>((r) => (child.exitCode !== null ? r(child.exitCode) : child.on('close', r)));

  const home = homedir();
  const redact = (l: string) => l.split(cwd).join('/work/repo').split(home).join('/home/user');
  writeFileSync(join(FIXTURES, `${name}.jsonl`), lines.map(redact).join('\n') + '\n');
  console.log(`${name}: ${lines.length} lines, exit ${code}${stderr ? `, stderr: ${stderr.trim().slice(0, 200)}` : ''}`);
}

mkdirSync(FIXTURES, { recursive: true });
const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(SCENARIOS);
// resume depends on multi-turn; everything else is independent and runs in parallel.
const first = names.filter((n) => n !== 'resume');
await Promise.all(first.map((n) => capture(n, SCENARIOS[n]!)));
if (names.includes('resume')) await capture('resume', SCENARIOS.resume!);
