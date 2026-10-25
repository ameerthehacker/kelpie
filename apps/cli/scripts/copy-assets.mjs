// Puts what the bundle needs beside it: the built web UI and the store's migrations.
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const dist = join(import.meta.dirname, '../dist');
const web = join(root, 'apps/web/dist');
if (!existsSync(join(web, 'index.html'))) throw new Error('apps/web is not built: run `pnpm --filter @kelpie/web build` first');
cpSync(web, join(dist, 'web'), { recursive: true });
cpSync(join(root, 'packages/store/drizzle'), join(dist, 'drizzle'), { recursive: true });
