import { randomUUID } from 'crypto';
import { SolidActions, SolidActionsConfig, WorkflowQueue } from '../src/';
import { startDockerPg, stopDockerPg } from '../src/cli/docker_pg_helper';
import { dropDatabases, PostgresChaosMonkey } from './helpers';
import { sleepms } from '../src/utils';

describe('chaos-tests', () => {
  let config: SolidActionsConfig;
  let chaosMonkey: PostgresChaosMonkey;

  jest.setTimeout(300000);

  beforeAll(() => {
    config = {
      name: 'test-app',
      systemDatabaseUrl: `postgresql://postgres:${process.env.PGPASSWORD || 'dbos'}@localhost:5432/dbostest?sslmode=disable`,
    };
    SolidActions.setConfig(config);
  });

  beforeEach(async () => {
    await startDockerPg();
    await dropDatabases(config);
    await SolidActions.launch();

    // Start chaos monkey after setup
    chaosMonkey = new PostgresChaosMonkey();
    chaosMonkey.start();
  });

  afterEach(async () => {
    // Stop chaos monkey before teardown
    if (chaosMonkey) {
      chaosMonkey.stop();
    }

    await SolidActions.shutdown();
    await stopDockerPg();
  });

  class TestWorkflow {
    @SolidActions.step()
    static async stepOne(x: number) {
      return Promise.resolve(x + 1);
    }

    @SolidActions.step()
    static async stepTwo(x: number) {
      return Promise.resolve(x + 2);
    }

    @SolidActions.workflow()
    static async workflow(x: number) {
      x = await TestWorkflow.stepOne(x);
      x = await TestWorkflow.stepTwo(x);
      return x;
    }
  }

  test('test-workflow', async () => {
    const numWorkflows = 5000;
    for (let i = 0; i < numWorkflows; i++) {
      await expect(TestWorkflow.workflow(i))
        .resolves.toEqual(i + 3)
        .catch((err) => {
          console.error(`Workflow ${i} failed:`, err);
          console.error('Full error object:', JSON.stringify(err, null, 2));
          throw err;
        });
      SolidActions.logger.info(i);
    }
  });

  class TestRecv {
    static topic = 'test_topic';

    @SolidActions.workflow()
    static async recvWorkflow() {
      return SolidActions.recv(TestRecv.topic, 10);
    }
  }

  test('test-recv', async () => {
    const numWorkflows = 5000;
    for (let i = 0; i < numWorkflows; i++) {
      const handle = await SolidActions.startWorkflow(TestRecv).recvWorkflow();
      const value = String(randomUUID());
      await SolidActions.send(handle.workflowID, value, TestRecv.topic);
      await expect(handle.getResult()).resolves.toEqual(value);
      SolidActions.logger.info(i);
    }
  });

  class TestEvents {
    static key = 'test_key';

    @SolidActions.workflow()
    static async eventWorkflow() {
      const value = String(randomUUID());
      await SolidActions.setEvent(TestEvents.key, value);
      return value;
    }
  }

  test('test-events', async () => {
    const numWorkflows = 5000;
    for (let i = 0; i < numWorkflows; i++) {
      const handle = await SolidActions.startWorkflow(TestEvents).eventWorkflow();
      const value = await handle.getResult();
      await expect(SolidActions.getEvent(handle.workflowID, TestEvents.key, 0)).resolves.toEqual(value);
      SolidActions.logger.info(i);
    }
  });

  class TestScheduled {
    static value = 0;

    @SolidActions.workflow()
    @SolidActions.scheduled({ crontab: '* * * * * *' })
    static async increment(_scheduled: Date, _actual: Date) {
      TestScheduled.value++;
      return Promise.resolve();
    }
  }

  test('test-scheduled', async () => {
    TestScheduled.value = 0;
    await sleepms(120000);
    expect(TestScheduled.value).toBeGreaterThan(60);
  });

  class TestQueues {
    static queue = new WorkflowQueue('queue');

    @SolidActions.step()
    static async stepOne(x: number) {
      return Promise.resolve(x + 1);
    }

    @SolidActions.step()
    static async stepTwo(x: number) {
      return Promise.resolve(x + 2);
    }

    @SolidActions.workflow()
    static async workflow(x: number) {
      x = await TestWorkflow.stepOne(x);
      x = await TestWorkflow.stepTwo(x);
      return x;
    }
  }

  test('test-queues', async () => {
    const numWorkflows = 60;
    for (let i = 0; i < numWorkflows; i++) {
      const handle = await SolidActions.startWorkflow(TestQueues, { queueName: TestQueues.queue.name }).workflow(i);
      await expect(handle.getResult()).resolves.toEqual(i + 3);
      SolidActions.logger.info(i);
    }
  });
});
