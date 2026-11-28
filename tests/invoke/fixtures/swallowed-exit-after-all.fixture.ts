// Run only by process-exit-interceptor.test.ts in a child Jest: the main run's testRegex does not match it.
// This afterAll runs after the afterAll that jest.teardown.ts registered.
afterAll(() => {
  try {
    process.exit(5);
  } catch {
    // swallowed on purpose: the hook itself finishes without an error
  }
});

it('passes before the swallowed exit', () => {
  expect(1 + 1).toBe(2);
});
