/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testRegex: '((\\.|/)(test|spec))\\.(ts|js)?$',
  testPathIgnorePatterns: [
    'packages/*',
    'tests/bundler-test/node_modules',
    'tests/bundler-test/dist',
    // Excluded until rewritten (SolidActions/solidactions-ts-sdk#41): it needs Postgres, which CI does not provide,
    // to test the database_url setup that the SDK no longer has.
    '<rootDir>/tests/bundler\\.test\\.ts$',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  modulePaths: ['./'],
  moduleNameMapper: {
    '^@dbos-inc/dbos-sdk$': `<rootDir>/src/index.ts`,
    '^@dbos-inc/dbos-sdk/(.*)$': '<rootDir>/src/$1',
  },
  modulePathIgnorePatterns: ['tests/proc-test'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/index.ts'],
  setupFiles: ['./jest.setup.ts'],
  setupFilesAfterEnv: ['./jest.teardown.ts'],
};
