/**
 * Runs the SQLite store test suites, each in its own process (the API test
 * derives paths from the cwd at import time, so it must not share a process
 * with the other suites).
 *
 * Run: bun tests/db/run.ts
 */

const suites = ['./differential.ts', './migration.ts', './api.ts'];

let failed = false;
for (const suite of suites) {
  const file = new URL(suite, import.meta.url).pathname;
  console.log(`\n==> ${suite}`);
  const proc = Bun.spawnSync(['bun', file], { stdout: 'inherit', stderr: 'inherit' });
  if (proc.exitCode !== 0) failed = true;
}

if (failed) {
  console.error('\nDB test suites FAILED');
  process.exit(1);
}
console.log('\nDB test suites passed');
