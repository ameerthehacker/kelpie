import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (see the `kelpie-src` export condition).
const conditions = ['kelpie-src', 'module', 'node'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: { include: ['packages/*/test/**/*.test.ts'] },
});
