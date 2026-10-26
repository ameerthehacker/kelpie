# kelpie-code

Kelpie is an orchestrator for coding agents. You give it many jobs at once ("RCA these 10 tickets", "add these three endpoints"). It plans the work, runs each piece as a sub-agent on **your own Claude Code**, gives every writing agent its own git worktree, and brings their branches back together. It stays free to take new work while agents run.

## Requirements

- Node.js 22 or newer
- [Claude Code](https://claude.com/claude-code), installed and logged in (run `claude` once)
- git, for worktrees (Kelpie also works outside a git repo, with one writer at a time)

## Start

```sh
cd your-repo
npx kelpie-code
```

Or install it once:

```sh
npm i -g kelpie-code
kelpie
```

`kelpie` serves the UI and its API on one local port, http://127.0.0.1:3173, and opens it in your browser. Stop it with Ctrl-C. Any work under way picks up again the next time you start it.

## Options

| Option | Environment | Default |
| --- | --- | --- |
| `-p, --port <port>` | `KELPIE_PORT` | `3173` |
| `-C, --cwd <dir>`: the repo agents work in | | the current directory |
| `--home <dir>`: round-ups, logs, worktrees, uploads | `KELPIE_HOME` | `~/.kelpie` |
| `--model <model>`: for new round-ups, e.g. `opus` | `KELPIE_MODEL` | Claude Code's default |
| `--no-open`: don't open a browser | | |

These limits are set through the environment: `KELPIE_MAX_AGENTS` (agents one round-up runs at once, 1–16, default 4; once you set it in Settings, that wins), `KELPIE_MAX_WORKTREES` (20), `KELPIE_WORKTREE_IDLE_DAYS` (3), and `KELPIE_MAX_UPLOAD_MB` (25).

Kelpie listens on 127.0.0.1 only: its agents can run commands on your machine.
