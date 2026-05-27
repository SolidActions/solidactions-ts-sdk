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

afterAll(async () => {
  await tearDownSolidActionsTestServer();
});
