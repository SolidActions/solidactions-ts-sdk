import { SolidActions } from '@solidactions/sdk';

class BundlerTestApp {
  @SolidActions.step()
  static async testStep(input: string): Promise<string> {
    console.log(`Processing step with input: ${input}`);
    return Promise.resolve(`Step processed: ${input}`);
  }

  @SolidActions.workflow()
  static async testWorkflow(input: string): Promise<string> {
    console.log(`Starting workflow with input: ${input}`);
    const stepResult = await BundlerTestApp.testStep(input);
    console.log(`Workflow completed with result: ${stepResult}`);
    return stepResult;
  }
}

async function main() {
  try {
    console.log('Starting SolidActions bundler test app...');

    // Configure SolidActions with minimal configuration
    const config = {
      name: 'bundler-test',
      database_url: process.env.SOLIDACTIONS_DATABASE_URL,
    };
    SolidActions.setConfig(config);

    // Initialize SolidActions
    await SolidActions.launch();

    // Test workflow execution (this is the main validation)
    const workflowResult = await BundlerTestApp.testWorkflow('bundler-test-input');
    console.log('Workflow result:', workflowResult);

    console.log('SolidActions bundler test completed successfully!');

    // Shutdown SolidActions
    await SolidActions.shutdown();

    process.exit(0);
  } catch (error) {
    console.error('Error in bundler test:', error);
    process.exit(1);
  }
}

// Only run main if this is the entry point
if (require.main === module) {
  main().catch(console.log);
}

export { BundlerTestApp, main };
