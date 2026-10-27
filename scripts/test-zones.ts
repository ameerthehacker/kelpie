/**
 * Runs the tests that format or place times in several time zones:
 *
 *   pnpm test:zones [zone...]
 *
 * They build their times in local time, so they hold in whatever zone they run in; `pnpm test` runs
 * them in the machine's own. This checks the ones a local-versus-UTC mix-up or a DST change would
 * trip: half-hour and odd offsets, both sides of UTC, and zones whose clocks change.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
// St John's: DST and a −3:30 offset. Calcutta: +5:30, no DST. New York and London: DST on different days.
const ZONES = ['America/St_Johns', 'America/New_York', 'Asia/Calcutta', 'Europe/London', 'UTC'];
const FILES = [
  'apps/web/test/limits.test.ts',
  'apps/web/test/usage.test.ts',
  'apps/web/test/workbench.test.ts',
  'apps/web/test/round-ups.test.ts',
  'packages/adapters/test/limits.test.ts',
  'packages/daemon/test/usage-limits.test.ts',
];

const zones = process.argv.slice(2).length ? process.argv.slice(2) : ZONES;
const failed = zones.filter((zone) => {
  console.log(`\n── TZ=${zone}`);
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...FILES], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TZ: zone } });
  return run.status !== 0;
});
if (failed.length) {
  console.error(`\nFailed in: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nPassed in: ${zones.join(', ')}`);
