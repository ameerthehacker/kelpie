import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (see the `kelpie-src` export condition).
const conditions = ['kelpie-src', 'module', 'node'];

// One time zone for every run, so local times format the same on any machine. The tests build their
// times in local time and hold in any zone: `TZ=Asia/Calcutta pnpm test` checks another.
process.env.TZ ||= 'UTC';

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Above the tests' own waits (5–10s), so a stuck one fails with its own error rather than a bare timeout.
    // The daemon's tests run git and spawn harnesses, and take seconds on a busy machine.
    testTimeout: 15_000,
  },
});
