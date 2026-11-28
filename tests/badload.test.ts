import { MockHttpServer } from '../src/testing/mock_server';
import { runTsScript, setUpSolidActionsTestServer } from './helpers';

describe('bad-code-loads', () => {
  let server: MockHttpServer;

  beforeAll(async () => {
    server = await setUpSolidActionsTestServer();
  });

  /** The programs read these; the mock server they point at runs in this process. */
  const testEnv = () => ({ SOLIDACTIONS_API_URL: server.baseUrl, SOLIDACTIONS_API_KEY: 'test-key' });

  test('loadCodeTwice', async () => {
    // Run the TypeScript test script under ts-node
    const result = await runTsScript('./tests/codereloader.ts', testEnv());

    // Uncomment to see what happened above...
    //console.log('STDOUT:', result.stdout);
    //console.error('STDERR:', result.stderr);

    // Check if the expected error appears in stderr
    expect(result.stderr).toContain('SolidActionsConflictingRegistrationError');
    expect(result.status).toBe(0);
  }, 90_000);

  test('loadCodeAfterLaunch', async () => {
    // Run the TypeScript test script under ts-node
    const result = await runTsScript('./tests/codelateloader.ts', testEnv());

    // Uncomment to see what happened above...
    //console.log('STDOUT:', result.stdout);
    //console.error('STDERR:', result.stderr);

    // Check if the expected error appears in stderr
    expect(result.stderr).toContain('SolidActionsConflictingRegistrationError');
    expect(result.status).toBe(1);
    // The late load is only late if launch() really connected first.
    expect(server.requestLog).toContainEqual(expect.objectContaining({ method: 'GET', path: '/health' }));
  }, 90_000);
});
