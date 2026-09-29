/**
 * Cross-platform test entry point.
 *
 * Passing a glob such as `"dist/test/**}{@/*}.test.js"` to `node --test` relies
 * on glob expansion inside the test runner, which only exists from Node 22. The
 * CI matrix starts at Node 20, so the file list is resolved here with fs
 * instead, then each test module is imported: importing a node:test file
 * registers and runs its tests.
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'test');

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error(`No compiled test files found in ${testDir}. Run "npm run build" first.`);
  process.exit(1);
}

for (const file of files) {
  await import(pathToFileURL(join(testDir, file)).href);
}
