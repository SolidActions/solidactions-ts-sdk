// Runs via `setupFilesAfterEnv` — i.e. after the test framework is installed,
// so jest lifecycle globals (afterAll) are available (unlike jest.setup.ts,
// which is a pre-framework `setupFiles` entry).
//
// Why this exists: tests start the in-memory mock HTTP server through
// setUpSolidActionsTestServer() but many suites (especially under tests/invoke)
// never stopped it in their own afterAll. The leaked listening socket made
// `jest --detectOpenHandles` hang indefinitely after the tests themselves had
// passed. Closing it here, once per test file, fixes the hang for every current
// and future suite without each one needing its own teardown.
//
// tearDownSolidActionsTestServer() is idempotent (it no-ops when no server is
// running and nulls the singleton after stopping), so suites that DO tear down
// themselves are unaffected regardless of hook order.
import { tearDownSolidActionsTestServer } from './tests/helpers';

// jest.setup.ts records every unarmed process.exit. Its throw alone is not enough: code that catches
// everything (invoke() never lets an exception escape) swallows it and the test would pass.
function failOnUnarmedExit(): void {
  const codes = (globalThis as { __unarmedProcessExits?: number[] }).__unarmedProcessExits?.splice(0) ?? [];
  if (codes.length > 0) {
    throw new Error(
      `${codes.map((code) => `process.exit(${code})`).join(', ')} was called outside expectProcessExit. ` +
        'This fails even when the caller caught the error.',
    );
  }
}

// In a test, or before it: fails that test.
afterEach(failOnUnarmedExit);

afterAll(async () => {
  await tearDownSolidActionsTestServer();
  // After the last test: fails the file.
  failOnUnarmedExit();
});

// Jest runs afterAll hooks in the order they were registered, so a test file's own hooks run after the one
// above. Follow each of them with the same check.
const registerAfterAll = globalThis.afterAll;
globalThis.afterAll = (fn, timeout) => {
  registerAfterAll(fn, timeout);
  registerAfterAll(failOnUnarmedExit);
};
