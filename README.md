# SolidActions SDK

Lightweight durable workflows for TypeScript.

## What is SolidActions?

SolidActions provides lightweight durable workflows built on top of an HTTP API backend.
Instead of managing your own workflow orchestrator or task queue system, you can use SolidActions to add durable workflows and queues to your program in just a few lines of code.

This SDK uses HTTP API calls to communicate with a SolidActions backend server (such as Laravel) that implements the workflow persistence API.

## Features

- **💾 Durable Workflows** - Checkpoint workflow state to automatically resume from failures
- **📒 Durable Queues** - Run tasks in the background with guaranteed completion
- **📅 Durable Scheduling** - Schedule workflows with cron syntax or durable sleep
- **📫 Durable Notifications** - Pause workflows until signals/notifications arrive
- **⚙️ Workflow Management** - Query, cancel, resume, or restart workflows programmatically

## Installation

```bash
npm install @solidactions/sdk
```

## Quick Start

```typescript
import { SolidActions } from '@solidactions/sdk';

// Register workflow steps
async function stepOne() {
  SolidActions.logger.info('Step one completed!');
}

async function stepTwo() {
  SolidActions.logger.info('Step two completed!');
}

// Register the workflow
async function workflowFunction() {
  await SolidActions.runStep(stepOne);
  await SolidActions.runStep(stepTwo);
}
const workflow = SolidActions.registerWorkflow(workflowFunction);
```

## Configuration

Configure via environment variables:

```bash
SOLIDACTIONS_API_URL=https://your-backend.com/api
SOLIDACTIONS_API_KEY=your-api-key
```

Or in code:

```typescript
import { SolidActions } from '@solidactions/sdk';

SolidActions.setConfig({
  name: 'my-app',
  api: {
    url: process.env.SOLIDACTIONS_API_URL!,
    key: process.env.SOLIDACTIONS_API_KEY!,
  },
});

await SolidActions.launch();
```

Or use a config file (`solidactions-config.yaml`):

```yaml
name: my-app
api:
  url: https://your-api-backend.com
  key: ${SOLIDACTIONS_API_KEY}
```

## Durable Workflows

Workflows checkpoint their state so they can resume from the last completed step after any failure:

```typescript
async function paymentWorkflow(orderId: string) {
  // Step 1: Reserve inventory
  await SolidActions.runStep(() => reserveInventory(orderId));

  // Step 2: Process payment (if this fails, we resume from step 2)
  await SolidActions.runStep(() => processPayment(orderId));

  // Step 3: Ship order
  await SolidActions.runStep(() => shipOrder(orderId));
}
const workflow = SolidActions.registerWorkflow(paymentWorkflow);
```

## Durable Queues

Run tasks in the background with guaranteed completion:

```typescript
import { SolidActions, WorkflowQueue } from '@solidactions/sdk';

const queue = new WorkflowQueue('background_tasks');

async function processTask(task: Task) {
  // Process the task...
}
const taskWorkflow = SolidActions.registerWorkflow(processTask);

// Enqueue work
await SolidActions.startWorkflow(taskWorkflow, { queueName: queue.name })(task);
```

## Durable Sleep

Sleep for any duration (even days) - workflows resume exactly when the sleep ends:

```typescript
async function reminderWorkflow(email: string) {
  await SolidActions.runStep(() => sendConfirmationEmail(email));
  await SolidActions.sleep(86400000); // Sleep 24 hours
  await SolidActions.runStep(() => sendReminderEmail(email));
}
```

## Signals and Events

Wait for external signals or emit events:

```typescript
async function approvalWorkflow(requestId: string) {
  // Wait for approval signal (with timeout)
  const approved = await SolidActions.recv<boolean>('approval', 3600);

  if (approved) {
    await SolidActions.runStep(() => processApproval(requestId));
  }
}
```

## Client API

Use the client to manage workflows programmatically:

```typescript
import { SolidActionsClient } from '@solidactions/sdk';

const client = SolidActionsClient.create();

// List workflows
const workflows = await client.listWorkflows({
  status: 'ERROR',
  startTime: '2025-04-22T03:00:00Z',
});

// Cancel or resume workflows
await client.cancelWorkflow(workflowId);
await client.resumeWorkflow(workflowId);
```

## Documentation

See `solidactions-ai-prompt.md` for comprehensive SDK documentation including:

- Workflow and step patterns
- Durable sleep, messaging, and events
- Queues and concurrency control
- Recovery and versioning
