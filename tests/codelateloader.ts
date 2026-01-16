import { SolidActions } from '@solidactions/sdk';

async function main() {
  // Config comes from environment variables set by the test runner
  await SolidActions.launch();
  const modulePath = require.resolve('./codereload');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(modulePath);
  await SolidActions.shutdown();
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
