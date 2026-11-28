import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const guard = path.join(root, 'scripts', 'check-test-run.mjs');

describe('check-test-run guard', () => {
  let dir: string;
  let everyListedFile: Array<{ name: string }>;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'check-test-run-'));
    everyListedFile = execFileSync(process.execPath, [require.resolve('jest/bin/jest'), './tests', '--listTests'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((name) => ({ name }));
    expect(everyListedFile.map((file) => file.name)).toContain(__filename);
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runGuard(results: object) {
    const file = path.join(dir, 'results.json');
    writeFileSync(file, JSON.stringify(results));
    return spawnSync(process.execPath, [guard, file], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  }

  it('passes when every listed test file has a result and Jest reports success', () => {
    const run = runGuard({ success: true, testResults: everyListedFile });

    expect(run.stderr).toBe('');
    expect(run.stdout).toContain(`all ${everyListedFile.length} test files have a result`);
    expect(run.status).toBe(0);
  }, 60_000);

  it('fails when every test file has a result but Jest reports success false', () => {
    const run = runGuard({ success: false, testResults: everyListedFile });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('success is false');
    expect(run.stdout).toBe('');
  }, 60_000);

  it('fails when the results do not say whether the run succeeded', () => {
    const run = runGuard({ testResults: everyListedFile });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('success is undefined');
    expect(run.stdout).toBe('');
  }, 60_000);
});
