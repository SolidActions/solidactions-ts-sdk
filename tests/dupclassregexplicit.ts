import { SolidActions } from '@solidactions/sdk';
import { generateSolidActionsTestConfig } from './helpers';

@SolidActions.className('TestClass')
class TestClass2 {
  @SolidActions.workflow()
  static async workflow2() {
    return Promise.resolve();
  }
}

SolidActions.registerWorkflow(async () => Promise.resolve('WF'), { className: 'TestClass', name: 'wf' });

async function main() {
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
