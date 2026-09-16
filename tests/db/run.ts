/**
 * Runs the SQLite store test suites.
 *
 * Run: bun tests/db/run.ts
 */

const suites = ['./differential', './migration'];

let failed = false;
for (const suite of suites) {
  try {
    await import(suite);
  } catch (err) {
    failed = true;
    console.error(`Unhandled error in ${suite}:`, err);
  }
  if (process.exitCode) failed = true;
}

if (failed) {
  console.error('DB test suites FAILED');
  process.exit(1);
}
console.log('DB test suites passed');
