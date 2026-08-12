import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const workflow = readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');

describe('publish workflow release guard', () => {
  test('requires the release tag to exactly match the committed package version before install, build, and publish', () => {
    const guardName = 'Verify release tag matches package version';
    const setupStart = workflow.indexOf('actions/setup-node@');
    const guardStart = workflow.indexOf(`- name: ${guardName}`);
    const guardEnd = workflow.indexOf('\n      - ', guardStart + 1);

    expect(setupStart).toBeGreaterThanOrEqual(0);
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardStart).toBeGreaterThan(setupStart);

    const guard = workflow.slice(guardStart, guardEnd === -1 ? undefined : guardEnd);
    expect(guard).toContain(`package_version="$(node -p "require('./package.json').version")"`);
    expect(guard).toContain('expected_tag="v${package_version}"');
    expect(guard).toContain('if [[ "${GITHUB_REF_NAME}" != "${expected_tag}" ]]; then');
    expect(guard).toContain("Release tag '${GITHUB_REF_NAME}'");
    expect(guard).toContain("package.json version '${package_version}'");
    expect(guard).toMatch(/exit 1/);

    for (const command of ['npm install -g npm@latest', 'npm ci', 'npm run build', 'npm publish']) {
      expect(guardStart).toBeLessThan(workflow.indexOf(command));
    }
  });
});
