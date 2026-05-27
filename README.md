# SolidActions SDK

[![npm version](https://img.shields.io/npm/v/@solidactions/sdk.svg)](https://www.npmjs.com/package/@solidactions/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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
import { SolidActions, defineWorkflow } from '@solidactions/sdk';

// Step functions
async function stepOne() {
  SolidActions.logger.info('Step one completed!');
}

async function stepTwo() {
  SolidActions.logger.info('Step two completed!');
}

// Define and export the workflow descriptor.
// The platform loads this module and runs run(ctx) per request.
export const workflow = defineWorkflow({
  name: 'my-workflow',
  async run(ctx) {
    await SolidActions.runStep(stepOne, { name: 'step-one' });
    await SolidActions.runStep(stepTwo, { name: 'step-two' });
  },
});
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
  await SolidActions.runStep(() => reserveInventory(orderId), { name: 'reserve' });

  // Step 2: Process payment (if this fails, we resume from step 2)
  await SolidActions.runStep(() => processPayment(orderId), { name: 'pay' });

  // Step 3: Ship order
  await SolidActions.runStep(() => shipOrder(orderId), { name: 'ship' });
}

export const workflow = defineWorkflow<{ orderId: string }, void>({
  name: 'payment',
  run: (ctx) => paymentWorkflow(ctx.input.orderId),
});
```

## Durable Queues

Run tasks in the background with guaranteed completion:

```typescript
import { SolidActions, defineWorkflow } from '@solidactions/sdk';

async function processTask(task: Task) {
  // Process the task...
}

export const taskWorkflow = defineWorkflow<Task, void>({
  name: 'process-task',
  run: (ctx) => processTask(ctx.input),
});

// Enqueue work onto a named queue
await SolidActions.startWorkflow(taskWorkflow, { queueName: 'background_tasks' })(task);
```

## Durable Sleep

Sleep for any duration (even days) - workflows resume exactly when the sleep ends:

```typescript
async function reminderWorkflow(email: string) {
  await SolidActions.runStep(() => sendConfirmationEmail(email), { name: 'confirm' });
  await SolidActions.sleep(86400000); // Sleep 24 hours
  await SolidActions.runStep(() => sendReminderEmail(email), { name: 'remind' });
}

export const reminder = defineWorkflow<{ email: string }, void>({
  name: 'reminder',
  run: (ctx) => reminderWorkflow(ctx.input.email),
});
```

## Signals and Events

Wait for external signals or emit events:

```typescript
async function approvalWorkflow(requestId: string) {
  // Wait for approval signal (with timeout)
  const approved = await SolidActions.recv<boolean>('approval', 3600);

  if (approved) {
    await SolidActions.runStep(() => processApproval(requestId), { name: 'process-approval' });
  }
}

export const approval = defineWorkflow<{ requestId: string }, void>({
  name: 'approval',
  run: (ctx) => approvalWorkflow(ctx.input.requestId),
});
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

## Deploying Workflows

Use the [`@solidactions/cli`](https://www.npmjs.com/package/@solidactions/cli) to deploy your workflows:

```bash
npm install -g @solidactions/cli

# Authenticate
solidactions init <api-key>

# Deploy your project
solidactions deploy <project-name> <path>
```

The CLI handles project creation, source upload, Docker builds, environment variables, and scheduling. See the [CLI repo](https://github.com/SolidActions/solidactions-cli) for full documentation.

## Documentation

See [`docs/sdk-reference.md`](docs/sdk-reference.md) for comprehensive SDK documentation including:

- The workflow contract: `defineWorkflow({ name, run })` and the `ctx` object (`ctx.input`, `ctx.vars`, `ctx.run`, `ctx.app`, modes)
- Context variables: typed `ctx.vars`, plain vars vs. `ConnectionVar` (OAuth proxy)
- Workflows: determinism rules, IDs and idempotency, timeouts, child workflows
- Steps: `runStep()`, configurable retries, parallel execution with `Promise.allSettled()`
- Durable primitives: `sleep()`, `now()`, `randomUUID()`
- Communication: `send()`/`recv()` messaging, `setEvent()`/`getEvent()` events, streaming, `respond()`
- Workflow handles and management: `listWorkflows()`, `cancelWorkflow()`, `forkWorkflow()`
- SolidActionsClient: standalone HTTP client for external workflow queries
- Configuration, custom serialization, testing, and error classes
- Recovery and versioning
