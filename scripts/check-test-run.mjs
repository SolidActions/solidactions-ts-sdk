// Fails unless Jest's JSON results account for every test file Jest lists, so a run that
// ends early cannot pass (ts-sdk#38). Usage: node scripts/check-test-run.mjs <results.json>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`check-test-run: ${message}`);
  process.exit(1);
}

const resultsPath = process.argv[2];
if (!resultsPath) {
  fail('no results file given. Usage: node scripts/check-test-run.mjs <results.json>');
}

let reported;
try {
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  reported = new Set(results.testResults.map((result) => result.name));
} catch (error) {
  fail(
    `cannot read Jest results from ${resultsPath}, so the test run did not finish or did not write them: ${error.message}`,
  );
}

const jest = createRequire(import.meta.url).resolve('jest/bin/jest');
const listed = execFileSync(process.execPath, [jest, './tests', '--listTests'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
if (listed.length === 0) {
  fail('jest ./tests --listTests listed no test files');
}

const missing = listed.filter((file) => !reported.has(file));
if (missing.length > 0) {
  fail(
    `${missing.length} of ${listed.length} test files have no result in ${resultsPath}:\n` +
      missing
        .map((file) => `  ${path.relative(root, file)}`)
        .sort()
        .join('\n'),
  );
}

console.log(`check-test-run: all ${listed.length} test files have a result`);
