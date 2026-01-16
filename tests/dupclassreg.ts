import { SolidActions } from '@solidactions/sdk';
import { generateSolidActionsTestConfig } from './helpers';

class TestClass {
  @SolidActions.workflow()
  static async workflow() {
    return Promise.resolve();
  }
}

@SolidActions.className('TestClass')
class TestClass2 {
  @SolidActions.workflow()
  static async workflow2() {
    return Promise.resolve();
  }
}

async function main() {
  new TestClass();
  new TestClass2();

  const config = generateSolidActionsTestConfig();
  SolidActions.setConfig(config);
  await SolidActions.launch();
  await SolidActions.shutdown();
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
