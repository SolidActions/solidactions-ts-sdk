// Run only by process-exit-interceptor.test.ts in a child Jest: the main run's testRegex does not match it.
// This afterEach runs after the afterEach that jest.teardown.ts registered, and the file has no afterAll.
afterEach(() => {
  try {
    process.exit(6);
  } catch {
    // swallowed on purpose: the hook itself finishes without an error
  }
});

it('passes before the swallowed exit', () => {
  expect(1 + 1).toBe(2);
});
