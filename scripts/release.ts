/**
 * Publishes kelpie-code (apps/cli) to npm, as one operation, from master only:
 *
 *   pnpm release [patch|minor|major|<x.y.z>] [--dry-run]     (default: patch)
 *
 * 1. Preflight, changing nothing: on master, clean, level with origin/master, the version and tag
 *    are new, logged in to npm, typecheck + tests + build pass, and `npm publish --dry-run` packs.
 * 2. Bump apps/cli/package.json, commit, and tag vX.Y.Z, locally.
 * 3. npm publish. If it fails, the commit and tag are undone, so nothing is left half done.
 * 4. git push --atomic of master and the tag together. Publishing can't be taken back, so if only
 *    this fails the local commit and tag stay, and the command to push them is printed.
 *
 * `--dry-run` stops after the preflight.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'apps/cli');
const PKG = join(CLI, 'package.json');
const BRANCH = 'master';
const BUMPS = ['patch', 'minor', 'major'] as const;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch';

function fail(message: string): never {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}

/** Runs a command and returns its trimmed output; throws if it fails. */
const out = (cmd: string, cmdArgs: string[], cwd = ROOT) => execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** Whether a command succeeds, output hidden. */
const ok = (cmd: string, cmdArgs: string[], cwd = ROOT) => spawnSync(cmd, cmdArgs, { cwd, stdio: 'ignore' }).status === 0;
/** Runs a command where the person can see it (and answer it, e.g. npm's one-time password). */
function step(title: string, cmd: string, cmdArgs: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  console.log(`\n▸ ${title}`);
  return spawnSync(cmd, cmdArgs, { cwd: opts.cwd ?? ROOT, stdio: 'inherit', env: opts.env ?? process.env }).status === 0;
}

// ── 1. preflight ─────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as { name: string; version: string };
const next = (BUMPS as readonly string[]).includes(bump) ? semver.inc(pkg.version, bump as (typeof BUMPS)[number]) : semver.valid(bump);
if (!next) fail(`"${bump}" is not patch, minor, major or a version like 1.2.3`);
if (!semver.gt(next, pkg.version)) fail(`${next} is not after the current version, ${pkg.version}`);
const tag = `v${next}`;
console.log(`Releasing ${pkg.name} ${pkg.version} → ${next}${dryRun ? ' (dry run)' : ''}`);

const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== BRANCH) fail(`releases are made only from ${BRANCH}; this is ${branch}`);
if (out('git', ['status', '--porcelain'])) fail('the working tree has changes: commit or stash them first');
if (!ok('git', ['fetch', '--quiet', 'origin', BRANCH, '--tags'])) fail('could not fetch origin');
const head = out('git', ['rev-parse', 'HEAD']);
const remote = out('git', ['rev-parse', `origin/${BRANCH}`]);
if (head !== remote) {
  const behind = out('git', ['rev-list', '--count', `HEAD..origin/${BRANCH}`]);
  fail(Number(behind) > 0 ? `${BRANCH} is behind origin/${BRANCH}: pull first` : `${BRANCH} has commits origin/${BRANCH} doesn't: push them first`);
}
if (ok('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`])) fail(`tag ${tag} already exists`);
if (!ok('npm', ['whoami'])) fail('not logged in to npm: run `npm login`');
if (ok('npm', ['view', `${pkg.name}@${next}`, 'version'])) fail(`${pkg.name}@${next} is already on npm`);

if (!step('Typecheck', 'pnpm', ['typecheck'])) fail('typecheck failed');
if (!step('Tests', 'pnpm', ['test'])) fail('tests failed');
if (!step('Build', 'pnpm', ['build:cli'])) fail('the build failed');
const releaseEnv = { ...process.env, KELPIE_RELEASE: '1' };
if (!step('npm publish --dry-run', 'npm', ['publish', '--dry-run'], { cwd: CLI, env: releaseEnv })) fail('npm publish --dry-run failed');

if (dryRun) {
  console.log(`\nDry run passed: \`pnpm release ${bump}\` would publish ${pkg.name}@${next} and push ${tag}.`);
  process.exit(0);
}

// ── 2. commit and tag, locally ───────────────────────────────────────────

const before = head;
writeFileSync(PKG, JSON.stringify({ ...pkg, version: next }, null, 2) + '\n');
const commit = ok('git', ['add', PKG]) && ok('git', ['commit', '--quiet', '-m', `release: ${pkg.name} ${tag}`]);
if (!commit || !ok('git', ['tag', '-a', tag, '-m', `${pkg.name} ${tag}`])) {
  ok('git', ['tag', '-d', tag]);
  ok('git', ['reset', '--hard', '--quiet', before]);
  fail('could not commit and tag the release; nothing was changed');
}

// ── 3. publish ───────────────────────────────────────────────────────────

// Ctrl-C (say, at the one-time password prompt) reaches npm too; stay alive to undo the commit and tag.
const ignore = () => {};
process.on('SIGINT', ignore);
const published = step(`npm publish ${pkg.name}@${next}`, 'npm', ['publish'], { cwd: CLI, env: releaseEnv });
process.off('SIGINT', ignore);
if (!published) {
  ok('git', ['tag', '-d', tag]);
  ok('git', ['reset', '--hard', '--quiet', before]);
  fail(`npm publish failed; the release commit and tag ${tag} were undone, and nothing was published or pushed`);
}

// ── 4. push ──────────────────────────────────────────────────────────────

if (!step(`Push ${BRANCH} and ${tag}`, 'git', ['push', '--atomic', 'origin', BRANCH, tag])) {
  fail(`${pkg.name}@${next} is published, but pushing failed. The release commit and tag are ready locally; push them with:\n  git push --atomic origin ${BRANCH} ${tag}`);
}
console.log(`\nReleased ${pkg.name}@${next} (${tag}).`);
