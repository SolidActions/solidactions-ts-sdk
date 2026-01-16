import { SolidActions } from '@solidactions/sdk';

async function main() {
  const modulePath = require.resolve('./codereload');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(modulePath);
  delete require.cache[modulePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(modulePath);

  await SolidActions.launch();
  await SolidActions.shutdown();
}

main()
  .then()
  .catch((e) => console.error(e));
