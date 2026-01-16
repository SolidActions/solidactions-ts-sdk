import { SolidActions } from '@solidactions/sdk';

class WF {
  @SolidActions.step()
  static async loggingStep() {
    SolidActions.logger.info(`Info: Step should be logged`);
    return Promise.resolve(1);
  }

  @SolidActions.workflow()
  static async loggingWorkflow() {
    SolidActions.logger.info(`Info: WFID should be logged`);
    return await WF.loggingStep();
  }
}

async function main() {
  // Config comes from environment variables set by the test runner
  SolidActions.setConfig({ addContextMetadata: true, enableOTLP: true });
  await SolidActions.launch();
  await SolidActions.withNextWorkflowID('loggerWorkflowId', async () => {
    SolidActions.logger.info(`The computed answer is ${await WF.loggingWorkflow()}`);
  });
  await SolidActions.shutdown();
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
