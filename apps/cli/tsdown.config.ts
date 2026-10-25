import { defineConfig } from 'tsdown';

/**
 * One file, `dist/cli.js`: Kelpie's own packages (@kelpie/*) are bundled in from source; every
 * dependency in package.json (better-sqlite3 is native) stays external and installs with the package.
 */
export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  deps: { alwaysBundle: [/^@kelpie\//] },
  fixedExtension: false,
  inputOptions: { resolve: { conditionNames: ['kelpie-src', 'import', 'node', 'default'] } },
});
