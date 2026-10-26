#!/usr/bin/env node
// Stand-in for `claude -p` in spawn tests. On the first stdin user turn it
// prints the fixture named by FAKE_FIXTURE (which already contains the
// replays of any later turns). With FAKE_HANG=1 it starts the turn and never
// finishes it, and ignores interrupts (a wedged CLI). FAKE_ARGS_FILE gets one
// line of JSON argv per start; FAKE_RESUME_FAIL=1 makes `--resume` fail the
// way the real CLI does for an unknown session; FAKE_EXIT_DELAY (ms) keeps it
// alive that long after stdin closes, like a slow shutdown. FAKE_EVERY_TURN=1 answers
// each later turn too (echo, "ok", result), and FAKE_STDIN_FILE gets a line of JSON
// { resume, text } per user turn received. FAKE_ASK=<command> asks permission to run that Bash
// command (can_use_tool) before the first turn's output, and goes on once answered; FAKE_ANSWER_FILE
// gets a line of JSON per answer. FAKE_ASK_TOOL=ExitPlanMode asks to put FAKE_ASK as a plan instead;
// FAKE_ASK_TOOL=AskUserQuestion asks FAKE_ASK as a question (options "Red" and "Blue"), or FAKE_ASK_INPUT's
// questions (the tool's input, as JSON) if set; any other FAKE_ASK_TOOL (e.g. mcp__claude-in-chrome__navigate)
// asks to use that tool on the url FAKE_ASK. Interrupted while asking, it ends the turn the way the real
// CLI does (ask-interrupt.jsonl): it cancels the request, unless FAKE_NO_CANCEL=1, then reports the turn aborted.
// FAKE_ENV_FILE gets a line of JSON per start with the GitHub env it was given (GH_TOKEN, GITHUB_TOKEN).
// FAKE_HOLD_FILE takes each user turn in (FAKE_STDIN_FILE gets it) but holds its answer for as long as that
// file exists; stdin is read in order, so whatever comes after a held turn (control requests, interrupts,
// further turns) waits with it.
// FAKE_ARGS_FILE has an --mcp-config file's contents in place of its path (as tests read the config);
// FAKE_RAW_ARGS_FILE gets the argv as given.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const lines = readFileSync(process.env.FAKE_FIXTURE, 'utf8').split('\n').filter(Boolean);
const hang = process.env.FAKE_HANG === '1';
let printed = false;
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
const args = process.argv.slice(2);
const logged = args.map((a, i) => (args[i - 1] === '--mcp-config' && existsSync(a) ? readFileSync(a, 'utf8') : a));
if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(logged) + '\n');
if (process.env.FAKE_RAW_ARGS_FILE) appendFileSync(process.env.FAKE_RAW_ARGS_FILE, JSON.stringify(args) + '\n');
if (process.env.FAKE_ENV_FILE) {
  appendFileSync(process.env.FAKE_ENV_FILE, JSON.stringify({ GH_TOKEN: process.env.GH_TOKEN ?? null, GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null }) + '\n');
}

const resume = args[args.indexOf('--resume') + 1];
if (process.env.FAKE_RESUME_FAIL === '1' && args.includes('--resume')) {
  const error = `No conversation found with session ID: ${resume}`;
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, num_turns: 0, session_id: resume, total_cost_usd: 0, usage: {}, errors: [error] });
  process.stderr.write(error + '\n');
  process.exit(1);
}

const ASK_ID = 'fake-ask-1';
let asking = false;
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === 'control_response' && msg.response?.request_id === ASK_ID && asking) {
    asking = false;
    if (process.env.FAKE_ANSWER_FILE) appendFileSync(process.env.FAKE_ANSWER_FILE, JSON.stringify(msg.response.response) + '\n');
    lines.forEach(out);
    continue;
  }
  if (msg.type === 'control_request') {
    if (msg.request?.subtype === 'interrupt' && asking && !hang) {
      asking = false;
      const session_id = JSON.parse(lines[0]).session_id;
      if (process.env.FAKE_NO_CANCEL !== '1') out({ type: 'control_cancel_request', request_id: ASK_ID });
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
      out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, session_id, parent_tool_use_id: null });
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', session_id, total_cost_usd: 0, usage: {} });
      continue;
    }
    if (!hang) out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
  } else if (msg.type === 'user' && process.env.FAKE_STDIN_FILE) {
    appendFileSync(process.env.FAKE_STDIN_FILE, JSON.stringify({ resume: args.includes('--resume') ? resume : null, text: msg.message.content[0].text }) + '\n');
  }
  while (msg.type === 'user' && process.env.FAKE_HOLD_FILE && existsSync(process.env.FAKE_HOLD_FILE)) await new Promise((r) => setTimeout(r, 10));
  if (msg.type === 'user' && printed && process.env.FAKE_EVERY_TURN === '1' && !hang) {
    const session_id = JSON.parse(lines[0]).session_id;
    out({ type: 'user', message: msg.message, session_id, parent_tool_use_id: null, isReplay: true });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, session_id, parent_tool_use_id: null });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id, total_cost_usd: 0, usage: {} });
  } else if (msg.type === 'user' && !printed) {
    printed = true;
    if (process.env.FAKE_ASK && !hang) {
      const command = process.env.FAKE_ASK;
      asking = true;
      const tool = process.env.FAKE_ASK_TOOL;
      const question = { question: command, header: 'Color', options: [{ label: 'Red', description: 'Bold' }, { label: 'Blue', description: 'Calm' }], multiSelect: false };
      const request =
        tool === 'ExitPlanMode'
          ? { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: command } }
          : tool === 'AskUserQuestion'
            ? { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: process.env.FAKE_ASK_INPUT ? JSON.parse(process.env.FAKE_ASK_INPUT) : { questions: [question] }, requires_user_interaction: true }
            : process.env.FAKE_ASK_TOOL
              ? { subtype: 'can_use_tool', tool_name: process.env.FAKE_ASK_TOOL, input: { url: command }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: process.env.FAKE_ASK_TOOL }], behavior: 'allow', destination: 'localSettings' }] }
              : { subtype: 'can_use_tool', tool_name: 'Bash', input: { command }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: command }], behavior: 'allow', destination: 'localSettings' }] };
      out({ type: 'control_request', request_id: ASK_ID, request });
    } else if (hang) {
      lines.filter((l) => !l.includes('"type":"result"')).slice(0, 3).forEach(out);
    } else {
      lines.forEach(out);
    }
  }
}

if (process.env.FAKE_EXIT_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_EXIT_DELAY)));
