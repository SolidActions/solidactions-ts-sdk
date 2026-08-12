import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = await readFile(path.join(root, 'README.md'), 'utf8');
const sdkReference = await readFile(path.join(root, 'docs/sdk-reference.md'), 'utf8');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const skillNames = [
  'solidactions-getting-started',
  'solidactions-workflow-coding',
  'solidactions-deploy-and-config',
  'solidactions-oauth-actions',
  'solidactions-crew-skills',
];

assert.equal(packageJson.engines?.node, '>=24', 'SDK package must require Node.js 24');
assert.equal(packageLock.version, packageJson.version, 'SDK package and lockfile versions must match');
assert.equal(
  packageLock.packages?.['']?.version,
  packageJson.version,
  'SDK lockfile root version must match the package',
);
assert(
  /workspace database bindings require `@solidactions\/sdk >=0\.8\.0`/i.test(sdkReference),
  'SDK reference must state the minimum version for workspace database bindings',
);
assert(
  /wire[^.\n]*`read_only`[^.\n]*hydration[^.\n]*`DatabaseVar\.readOnly`/i.test(sdkReference),
  'SDK reference must explain read_only wire hydration to DatabaseVar.readOnly',
);
for (const command of [
  'solidactions login --global',
  'solidactions init my-workflow --claude',
  'solidactions init my-workflow --agents',
  'solidactions project deploy my-workflow -e production',
  'solidactions run start my-workflow hello -e production',
]) {
  assert(readme.includes(command), `README is missing current command: ${command}`);
}
for (const skillName of skillNames) {
  assert(readme.includes(skillName), `README does not name generated skill ${skillName}`);
}
for (const [label, pattern] of [
  ['public docs link', /https:\/\/www\.solidactions\.com\/docs/],
  ['Claude skill directory', /\.claude\/skills\//],
  ['agent skill directory', /\.agents\/skills\//],
  ['SDK reference location', /\.solidactions\/sdk-reference\.md/],
]) {
  assert(pattern.test(readme), `README is missing ${label}`);
}
for (const [label, pattern] of [
  ['retired docs host', /docs\.solidactions\.com/],
  ['redirecting apex docs host', /https:\/\/solidactions\.com\/docs/],
  ['obsolete argv login', /solidactions login\s+<(?:api-key|your-api-key|key)>/i],
  ['obsolete init authentication', /solidactions init\s+<(?:api-key|your-api-key|key)>/i],
  ['obsolete top-level deploy', /solidactions deploy\s+/],
  ['obsolete colon-style command', /solidactions\s+[a-z-]+:[a-z-]+/i],
]) {
  assert(!pattern.test(readme), `README contains ${label}`);
}

console.log(`SDK docs contract passed for Node.js 24 and ${skillNames.length} generated skills.`);
