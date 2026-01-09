# @solidactions/sdk

A durable workflow SDK for building reliable, resumable workflows with SolidActions.

## Features

- **Durable execution**: Steps survive container restarts and crashes
- **Sleep for hours/days**: No resource consumption during waits
- **Human-in-the-loop**: Wait for external signals and approvals
- **Child workflows**: Spawn and await other workflows
- **Per-step retries**: Automatic retry with configurable backoff
- **Error handlers**: onFailure callbacks for cleanup and notifications
- **Automatic replay**: Completed steps are cached and skipped on resume
- **Zero dependencies**: No external databases required

## Installation

```bash
npm install @solidactions/sdk
```

## Quick Start

```typescript
import { SOLIDACTIONS } from '@solidactions/sdk';

// Define a workflow with durable steps
export const processOrder = SOLIDACTIONS.workflow(
  { id: 'process-order' },
  async (ctx, step) => {
    // step.run() - Execute with durability guarantees
    const order = await step.run('validate', async () => {
      return validateOrder(ctx.input.orderId);
    });

    // step.sleep() - Sleep without consuming resources
    await step.sleep('wait-for-payment', 60 * 60 * 1000); // 1 hour

    // step.waitForSignal() - Wait for human approval
    const approval = await step.waitForSignal('approval', {
      signal: `order-${ctx.input.orderId}-approval`,
      timeout: 24 * 60 * 60 * 1000, // 24 hours
    });

    if (approval) {
      await step.run('fulfill', async () => {
        return fulfillOrder(ctx.input.orderId);
      });
    }

    return { orderId: ctx.input.orderId, approved: !!approval };
  }
);
```

## API Reference

### SOLIDACTIONS.workflow(options, handler)

Define a new workflow.

```typescript
const myWorkflow = SOLIDACTIONS.workflow(
  { id: 'my-workflow', maxAttempts: 4 },
  async (ctx, step) => {
    // ctx.input - Input data passed to the workflow
    // ctx.runId - Unique run identifier
    // ctx.env - Environment variables
    // step - Step interface for durable operations
    return result;
  }
);
```

### step.run(id, handler)

Execute a step with durability guarantees. If the step was already executed (on resume), returns the cached result without re-executing.

```typescript
const result = await step.run('my-step', async () => {
  // This code runs at most once per workflow run
  return await someApiCall();
});
```

### step.sleep(id, durationMs)

Pause workflow execution for a duration. The container exits and is resumed by the scheduler after the duration elapses.

```typescript
// Sleep for 1 hour - container exits, resources freed
await step.sleep('wait', 60 * 60 * 1000);
```

### step.waitForSignal(id, options)

Wait for an external signal. Used for human-in-the-loop patterns like approvals.

```typescript
// Wait up to 24 hours for approval
const data = await step.waitForSignal('approval', {
  signal: 'order-123-approval',
  timeout: 24 * 60 * 60 * 1000,
});

if (data) {
  // Signal was received
  console.log('Approved with comment:', data.comment);
} else {
  // Timed out
  console.log('Approval timed out');
}
```

### step.prepareSignal(id, options)

Prepare a signal waiter and get public URLs for email buttons. Use this when you need to send an email with clickable buttons before waiting for a response.

```typescript
// 1. Prepare the signal (registers waiter, returns URLs)
const signal = await step.prepareSignal('approval', {
  signal: `order-${ctx.input.orderId}`,
  timeout: 24 * 60 * 60 * 1000,
});

// 2. Send email with buttons using the URLs
await step.run('send-email', async () => {
  await sendEmail({
    to: 'user@example.com',
    subject: 'Approval Needed',
    buttons: [
      { text: 'Approve', url: signal.urlWithChoice('approve') },
      { text: 'Reject', url: signal.urlWithChoice('reject') },
    ]
  });
});

// 3. Wait for button click (exits container until signal received)
const response = await signal.wait();

// 4. Process the response
if (response?.choice === 'approve') {
  // User clicked Approve
}
```

The `PreparedSignal` object contains:
- `url` - Base signal URL
- `token` - Unique signal token
- `name` - Signal name
- `urlWithChoice(choice)` - Helper to create URL with `?choice=` param
- `wait()` - Exit and wait for the signal

### step.run() with Retries

Execute a step with automatic retry on failure. Retries are SDK-internal (non-durable) and happen within a single container run.

```typescript
const result = await step.run('api-call', { url }, async (input) => {
  const response = await fetch(input.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}, {
  retries: 3,              // Retry up to 3 times (4 total attempts)
  backoff: 'exponential',  // 'exponential' | 'linear' | number (fixed ms)
  backoffBase: 1000,       // Base delay: 1s, 2s, 4s for exponential
});
```

### step.runWorkflow(id, workflowId, input, options?)

Spawn a child workflow and wait for its result. Combines `spawnWorkflow` + `awaitWorkflow`.

```typescript
// Run a child workflow and get its result
const childResult = await step.runWorkflow<ProcessResult>(
  'process-items',           // Step ID
  'item-processor',          // Child workflow ID
  { items: data.items },     // Input for child
  { inlineTimeout: 5000 }    // Optional: poll for 5s before durable wait
);
```

### step.spawnWorkflow(id, workflowId, input)

Spawn a child workflow without waiting. Returns a handle for later awaiting.

```typescript
// Spawn multiple children in parallel
const handles = await Promise.all(
  items.map((item, i) =>
    step.spawnWorkflow(`spawn-${i}`, 'item-processor', { item })
  )
);

// Do other work while children run...

// Await all children
const results = await Promise.all(
  handles.map((handle, i) =>
    step.awaitWorkflow<Result>(`await-${i}`, handle)
  )
);
```

### step.awaitWorkflow(id, handle, options?)

Wait for a spawned child workflow to complete.

```typescript
const handle = await step.spawnWorkflow('spawn', 'child-workflow', input);

// ... do other work ...

const result = await step.awaitWorkflow<ChildOutput>('await', handle, {
  inlineTimeout: 3000  // Poll for 3s, then exit and wait durably
});
```

### Workflow Error Handlers

Define an `onFailure` handler to run cleanup or notifications when a workflow fails.

```typescript
const processOrder = SOLIDACTIONS.workflow(
  {
    id: 'process-order',
    onFailure: async (ctx, errors) => {
      // errors contains step ID -> error info
      const failedStep = Object.keys(errors)[0];
      const error = errors[failedStep];

      await sendAlert({
        orderId: ctx.input.orderId,
        step: failedStep,
        error: error.message,
        attempt: error.attempt,
      });
    }
  },
  async (ctx, step) => {
    // Workflow code...
  }
);
```

## Sending Signals

### Authenticated API (for backend integrations)

```bash
curl -X POST https://your-app.com/api/signals/order-123-approval \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data": {"approved": true, "comment": "LGTM"}}'
```

### Public Signal URL (for email buttons)

When using `prepareSignal()`, you get a public URL that requires no authentication:

```
https://your-app.com/api/public/signals/{signalToken}?choice=approve
```

- GET requests show a nice confirmation page to the user
- POST requests return JSON (for webhook integrations)
- Each signal token is unique and single-use

## Helper Functions

### getWorkflowInput()

Get the full workflow input object.

```typescript
import { getWorkflowInput } from '@solidactions/sdk';

interface MyInput {
  orderId: string;
  customerId: string;
}

const input = getWorkflowInput<MyInput>();
console.log(input?.orderId);
```

### getInputValue(key, defaultValue?)

Get a specific value from input with optional default.

```typescript
import { getInputValue } from '@solidactions/sdk';

const orderId = getInputValue<string>('orderId', 'unknown');
const retries = getInputValue<number>('config.retries', 3);
```

### isRunningOnSolidActions()

Check if running on the SolidActions platform.

```typescript
import { isRunningOnSolidActions } from '@solidactions/sdk';

if (isRunningOnSolidActions()) {
  // Use durable operations
} else {
  // Local development mode
}
```

## Environment Variables

The SDK reads these environment variables when running on SolidActions:

| Variable | Description |
|----------|-------------|
| `SOLIDACTIONS_API_URL` | Internal API URL for state persistence |
| `SOLIDACTIONS_RUN_ID` | Unique identifier for this workflow run |
| `SOLIDACTIONS_AUTH_TOKEN` | Authentication token for API calls |
| `WORKFLOW_INPUT` | JSON-stringified input data |
| `WORKFLOW_INPUT_FILE` | Path to input JSON file (default: `/app/input.json`) |

## How It Works

1. **Execution**: When a workflow runs, each `step.run()` checks if the step was already executed
2. **Caching**: Completed steps are persisted to the database via HTTP
3. **Replay**: On resume, completed steps return cached results instantly
4. **Sleep/Signal**: Container exits, scheduler resumes when time elapses or signal arrives

```
Container starts
    │
    ├─▶ step.run("a") → Check DB → Not found → Execute → Save → Continue
    ├─▶ step.run("b") → Check DB → Not found → Execute → Save → Continue
    ├─▶ step.sleep("wait", 1hr) → Save to DB → Exit container
    │
    │   ... 1 hour passes ...
    │
Container resumes (new instance)
    │
    ├─▶ step.run("a") → Check DB → Found! → Return cached → Skip
    ├─▶ step.run("b") → Check DB → Found! → Return cached → Skip
    ├─▶ step.sleep("wait") → Check DB → Completed! → Skip
    ├─▶ step.run("c") → Execute → Save → Continue
    └─▶ Return final result
```

## License

MIT
