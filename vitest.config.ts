import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (see the `kelpie-src` export condition).
const conditions = ['kelpie-src', 'module', 'node'];

export default defineConfig({
  // The web app's `@/` imports (see apps/web/vite.config.ts), for tests of its components.
  resolve: { conditions, alias: [{ find: /^@\//, replacement: fileURLToPath(new URL('./apps/web/src/', import.meta.url)) }] },
  ssr: { resolve: { conditions } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Above the tests' own waits (5–10s), so a stuck one fails with its own error rather than a bare timeout.
    // The daemon's tests run git and spawn harnesses, and take seconds on a busy machine.
    testTimeout: 15_000,
  },
});
