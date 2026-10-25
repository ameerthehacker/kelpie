// Publishing goes through `pnpm release` (scripts/release.ts), which checks the branch and tags the
// release; a stray `npm publish` would skip all of that.
if (process.env.KELPIE_RELEASE !== '1') {
  console.error('kelpie-code is published with `pnpm release` from master, not `npm publish`.');
  process.exit(1);
}
