import { execFile } from 'node:child_process';
import path from 'node:path';
import { expectProcessExit } from './helpers-exit';

/** The codes jest.setup.ts recorded for unarmed calls. A row that expects the throw must empty it. */
function takeUnarmedExits(): number[] {
  return ((globalThis as Record<string, unknown>).__unarmedProcessExits as number[] | undefined)?.splice(0) ?? [];
}

interface FileResult {
  status: string;
  message: string;
  assertionResults: Array<{ title: string; status: string; failureMessages: string[] }>;
}

interface FixtureRun {
  status: number | null;
  fileStatus: string;
  fileMessage: string;
  tests: FileResult['assertionResults'];
}

/** Runs one fixture file in a child Jest with this repo's config, so jest.setup.ts and jest.teardown.ts apply. */
function runFixture(file: string): Promise<FixtureRun> {
  const args = [
    require.resolve('jest/bin/jest'),
    '--runTestsByPath',
    path.join(__dirname, 'fixtures', file),
    '--testRegex',
    '\\.fixture\\.ts$',
    '--coverage=false',
    '--json',
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      args,
      { cwd: path.resolve(__dirname, '../..'), timeout: 60_000, killSignal: 'SIGKILL' },
      (_error, stdout, stderr) => {
        try {
          const [result] = (JSON.parse(stdout) as { testResults: FileResult[] }).testResults;
          resolve({
            status: child.exitCode,
            fileStatus: result.status,
            fileMessage: result.message,
            tests: result.assertionResults,
          });
        } catch {
          reject(new Error(`child Jest gave no results (status ${child.exitCode}):\n${stderr}`));
        }
      },
    );
  });
}

it('process.exit is intercepted as an observable throw when armed, not fatal', async () => {
  const code = await expectProcessExit(() => {
    process.exit(3);
  });
  expect(code).toBe(3);
  expect(takeUnarmedExits()).toEqual([]);
});

it('interceptor defaults to disarmed: the arm flag is falsy outside expectProcessExit', () => {
  expect((globalThis as Record<string, unknown>).__processExitArmed).toBeFalsy();
  expect(typeof process.exit).toBe('function');
});

it('an unarmed process.exit throws an error naming the code and expectProcessExit instead of ending the run', () => {
  expect((globalThis as Record<string, unknown>).__processExitArmed).toBeFalsy();

  let thrown: unknown;
  try {
    process.exit(7);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).name).not.toBe('ProcessExitSignal');
  expect((thrown as Error).message).toContain('process.exit(7)');
  expect((thrown as Error).message).toContain('expectProcessExit');
  expect(takeUnarmedExits()).toEqual([7]);
});

it('an unarmed process.exit with no argument names exit code 0', () => {
  expect((globalThis as Record<string, unknown>).__processExitArmed).toBeFalsy();

  expect(() => process.exit()).toThrow('process.exit(0)');
  expect(takeUnarmedExits()).toEqual([0]);
});

it('a test that swallows the throw of an unarmed process.exit still fails, and the next test does not', async () => {
  const run = await runFixture('swallowed-exit-in-test.fixture.ts');

  expect(run.status).toBe(1);
  expect(run.tests.map((test) => [test.title, test.status])).toEqual([
    ['swallows an unarmed process.exit', 'failed'],
    ['a later test that calls no exit', 'passed'],
  ]);
  expect(run.tests[0].failureMessages.join('\n')).toContain('process.exit(4) was called outside expectProcessExit');
}, 90_000);

it.each([
  ["a file's own afterAll", 'swallowed-exit-after-all.fixture.ts', 5],
  ["a file's own afterEach after the last test", 'swallowed-exit-after-each.fixture.ts', 6],
])(
  'a swallowed unarmed process.exit in %s fails the file',
  async (_where, fixture, code) => {
    const run = await runFixture(fixture);

    expect(run.status).toBe(1);
    expect(run.tests.map((test) => [test.title, test.status])).toEqual([
      ['passes before the swallowed exit', 'passed'],
    ]);
    expect(run.fileStatus).toBe('failed');
    expect(run.fileMessage).toContain(`process.exit(${code}) was called outside expectProcessExit`);
  },
  90_000,
);
