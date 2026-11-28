// Run only by process-exit-interceptor.test.ts in a child Jest: the main run's testRegex does not match it.
it('swallows an unarmed process.exit', () => {
  try {
    process.exit(4);
  } catch {
    // swallowed on purpose: the test body itself finishes without an error
  }
});

it('a later test that calls no exit', () => {
  expect(1 + 1).toBe(2);
});
