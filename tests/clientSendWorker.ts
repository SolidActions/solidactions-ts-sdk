import { exit } from 'process';
import { SolidActions } from '../src';
import { generateSolidActionsTestConfig } from './helpers';

class ClientTest {
  @SolidActions.workflow()
  static async enqueueTest(
    numVal: number,
    strVal: string,
    objVal: { first: string; last: string; age: number },
  ): Promise<string> {
    return Promise.resolve(`${numVal}-${strVal}-${JSON.stringify(objVal)}`);
  }

  @SolidActions.workflow()
  static async sendTest(topic?: string) {
    return await SolidActions.recv<string>(topic);
  }

  @SolidActions.workflow()
  static async eventTest(key: string, value: string, update: boolean = false) {
    await SolidActions.setEvent(key, value);
    await SolidActions.sleepSeconds(5);
    if (update) {
      await SolidActions.setEvent(key, `updated-${value}`);
    }
    return `${key}-${value}`;
  }
}

async function main() {
  console.log(`app version ${process.env.SOLIDACTIONS__APPVERSION}`);
  const config = generateSolidActionsTestConfig();
  SolidActions.setConfig(config);
  await SolidActions.launch();

  const workflowID = process.argv[2];
  const topic = process.argv[3];

  if (!workflowID) {
    console.error('workflowID not provided');
    process.exit(1);
  }

  if (!topic) {
    console.error('topic not provided');
    process.exit(1);
  }

  await SolidActions.startWorkflow(ClientTest, { workflowID }).sendTest(topic);
  console.log(`Workflow ${workflowID} started`);
  exit(0);
}

if (require.main === module) {
  main()
    .then(() => {})
    .catch((e) => {
      console.log(e);
      exit(1);
    });
}
