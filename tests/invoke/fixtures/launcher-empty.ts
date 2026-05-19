/**
 * T3 launcher selection-failure fixture — module exports NO workflows.
 * Importing it leaves the registry empty (after `__clearRegistry()` in the
 * test's beforeEach), so selection routes to the synthetic-failure path.
 */
export const marker = 'no-workflows-here';
