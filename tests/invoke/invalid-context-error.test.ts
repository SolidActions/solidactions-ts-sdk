import { SolidActionsInvalidContextError } from '../../src/error';

it('SolidActionsInvalidContextError is a SolidActionsError subclass with a remedy string', () => {
  const err = new SolidActionsInvalidContextError(
    'SolidActions.now',
    'Call SolidActions.now() inside a workflow body defined with defineWorkflow() or SolidActions.registerWorkflow()',
  );
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain('SolidActions.now');
  expect(err.message).toContain('Call SolidActions.now()');
  expect(err.solidActionsErrorCode).toBe(39);
  expect(err.name).toBe('SolidActionsInvalidContextError');
});
