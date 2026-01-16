# Build Reliable Workflows With SolidSteps SDK

## Guidelines

- Respond in a friendly and concise manner
- Ask clarifying questions when requirements are ambiguous
- Generate code in TypeScript using the SolidSteps DBOS SDK. Make sure to fully type everything.
- You MUST import all methods and classes used in the code you generate
- You SHALL keep all code in a single file unless otherwise specified
- You MUST await all promises
- The SolidSteps SDK is a fork of `@dbos-inc/dbos-sdk` optimized for container-based execution

## SolidSteps vs Original DBOS

The SolidSteps SDK differs from the original `@dbos-inc/dbos-sdk` in key ways:

| Feature         | Original DBOS            | SolidSteps SDK                                |
| --------------- | ------------------------ | --------------------------------------------- |
| **Backend**     | Direct PostgreSQL        | HTTP API (Laravel backend)                    |
| **Sleep**       | In-process wait          | Container exits, scheduler wakes              |
| **Recv**        | In-process polling       | Container exits, wakes on signal              |
| **Config**      | `setConfig()` required   | Auto-config from `solidsteps.yaml` + env vars |
| **Entry Point** | Manual `main()` function | `DBOS.run()` one-liner                        |

### Key Behavioral Differences

**`DBOS.sleep(ms)`** - Container exits during sleep, zero resources consumed. Scheduler wakes workflow after duration. Supports sleeps of seconds to weeks.

**`DBOS.recv(topic?, timeoutSeconds?)`** - Container exits while waiting for message. Wakes immediately when signal arrives via HTTP endpoint. No polling, no resource usage during wait.

**`DBOS.send(destinationID, message, topic?)`** - Stores message AND wakes waiting destination workflow if it's in 'waiting' status.

## Simplified APIs (SolidSteps-Only)

### `DBOS.run(workflow)`

One-liner entry point that handles the full lifecycle:

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

async function myWorkflow(input: MyInput): Promise<MyOutput> {
  // workflow logic
}

const wf = DBOS.registerWorkflow(myWorkflow, { name: 'my-workflow' });
DBOS.run(wf);
```

`DBOS.run()` automatically:

1. Reads config from `solidsteps.yaml` + env vars (no `setConfig()` needed)
2. Calls `launch()`
3. Parses `WORKFLOW_INPUT` env var via `getInput()`
4. Runs the workflow and awaits result
5. Calls `shutdown()` and exits with code 0 (or 1 on error)

### `DBOS.getInput<T>()`

Parse the `WORKFLOW_INPUT` environment variable (set by runner from webhook payload):

```typescript
interface MyInput {
  taskId: string;
  value: number;
}

// Inside workflow function
const input = DBOS.getInput<MyInput>();
// Returns {} if WORKFLOW_INPUT not set or invalid JSON
```

### `DBOS.getSignalUrls(topic?)`

Generate signal URLs for external signals (email buttons, webhooks):

```typescript
// Inside a workflow
const urls = DBOS.getSignalUrls('approval');
// Returns:
// {
//   base: "http://localhost:8000/api/signal/{workflowId}",
//   approve: "http://localhost:8000/api/signal/{workflowId}?choice=approve&topic=approval",
//   reject: "http://localhost:8000/api/signal/{workflowId}?choice=reject&topic=approval",
//   custom: (action) => "http://localhost:8000/api/signal/{workflowId}?choice={action}&topic=approval"
// }
```

## Environment Variables

These environment variables are available inside workflow containers:

| Variable               | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `WORKFLOW_INPUT`       | JSON-encoded input from webhook payload                         |
| `DBOS_WORKFLOW_UUID`   | Pre-generated workflow UUID (use this, don't generate your own) |
| `DBOS_API_URL`         | SolidSteps API URL (e.g., `http://localhost:8000/api/internal`) |
| `DBOS_API_KEY`         | Authentication token for API calls                              |
| `SOLIDACTIONS_API_URL` | Same as DBOS_API_URL (alternative name)                         |
| `APP_URL`              | Base application URL for signal generation                      |

## Workflow Guidelines

Workflows provide durable execution so you can write programs that are resilient to any failure.
Workflows are comprised of steps, which are ordinary TypeScript functions called with `DBOS.runStep()`.
When using DBOS workflows, you should call any function that performs complex operations or accesses external APIs or services as a step using `DBOS.runStep()`.

If a workflow is interrupted for any reason (e.g., container exits during sleep), when the workflow resumes it automatically continues from the last completed step.

### Rules for Workflows

- If asked to add DBOS to existing code, you MUST ask which function to make a workflow. Do NOT recommend any changes until they have told you what function to make a workflow.
- When making a function a workflow, you should make all functions it calls steps. Do NOT change the functions in any way.
- Do NOT make functions steps unless they are DIRECTLY called by a workflow.
- If the workflow function performs a non-deterministic action, you MUST move that action to its own function and make that function a step. Examples: accessing an external API, reading files, generating a random number, getting the current time.
- Do NOT use `Promise.all()` due to the risks posed by multiple rejections. Using `Promise.allSettled()` for parallelism is allowed for single-step promises only.
- DBOS workflows and steps should NOT have side effects in memory outside of their own scope.
- Do NOT call any DBOS context method (`DBOS.send`, `DBOS.recv`, `DBOS.startWorkflow`, `DBOS.sleep`, `DBOS.setEvent`, `DBOS.getEvent`) from a step.
- Do NOT start workflows from inside a step.

## Complete Workflow Examples

### Simple Steps (Basic Pattern)

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

interface TaskInput {
  taskId: string;
  value: number;
}

interface TaskResult {
  taskId: string;
  processedValue: number;
  steps: string[];
}

async function initialize(taskId: string) {
  console.log(`Initializing task: ${taskId}`);
  return { initialized: true };
}

async function validate(value: number) {
  if (value < 0) throw new Error('Value must be non-negative');
  return { valid: true, value };
}

async function process(value: number) {
  return { result: value * 2 + 10 };
}

async function simpleWorkflow(input: TaskInput): Promise<TaskResult> {
  const taskId = input.taskId || 'default';
  const value = input.value ?? 0;
  const steps: string[] = [];

  await DBOS.runStep(() => initialize(taskId), { name: 'initialize' });
  steps.push('initialize');

  const validation = await DBOS.runStep(() => validate(value), { name: 'validate' });
  steps.push('validate');

  const processed = await DBOS.runStep(() => process(validation.value), { name: 'process' });
  steps.push('process');

  return { taskId, processedValue: processed.result, steps };
}

const workflow = DBOS.registerWorkflow(simpleWorkflow, { name: 'simple-workflow' });
DBOS.run(workflow);
```

### Durable Sleep

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

interface SleepInput {
  taskId: string;
  sleepMs?: number;
}

async function recordStart() {
  return { startedAt: new Date().toISOString(), startMs: Date.now() };
}

async function recordEnd(startMs: number) {
  const endMs = Date.now();
  return {
    completedAt: new Date().toISOString(),
    durationMs: endMs - startMs,
  };
}

async function sleepWorkflow(input: SleepInput) {
  const sleepMs = input.sleepMs ?? 5000;

  const start = await DBOS.runStep(() => recordStart(), { name: 'record-start' });

  console.log(`Sleeping for ${sleepMs}ms...`);
  // Container exits here, scheduler wakes after duration
  await DBOS.sleep(sleepMs);
  console.log('Woke up!');

  const end = await DBOS.runStep(() => recordEnd(start.startMs), { name: 'record-end' });

  return {
    taskId: input.taskId,
    sleepMs,
    actualDurationMs: end.durationMs,
  };
}

const workflow = DBOS.registerWorkflow(sleepWorkflow, { name: 'sleep-workflow' });
DBOS.run(workflow);
```

### Human-in-the-Loop (External Signals)

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

interface ApprovalInput {
  invoiceId: string;
  amount: number;
  approverEmail: string;
}

async function createInvoice(input: ApprovalInput) {
  console.log(`Created invoice ${input.invoiceId} for $${input.amount}`);
  return { invoiceId: input.invoiceId, createdAt: new Date().toISOString() };
}

async function sendEmail(email: string, urls: { approve: string; reject: string }) {
  console.log(`Sending approval email to ${email}`);
  console.log(`  Approve: ${urls.approve}`);
  console.log(`  Reject: ${urls.reject}`);
  return { sent: true };
}

async function markApproved(invoiceId: string) {
  console.log(`Invoice ${invoiceId} APPROVED`);
  return { status: 'approved' as const };
}

async function markRejected(invoiceId: string, reason?: string) {
  console.log(`Invoice ${invoiceId} REJECTED: ${reason || 'No reason given'}`);
  return { status: 'rejected' as const, reason };
}

async function approvalWorkflow(input: ApprovalInput) {
  const invoiceId = input.invoiceId || 'INV-001';

  // Step 1: Create invoice
  await DBOS.runStep(() => createInvoice(input), { name: 'create-invoice' });

  // Step 2: Generate signal URLs and send email
  const urls = DBOS.getSignalUrls('approval');
  await DBOS.runStep(() => sendEmail(input.approverEmail, urls), { name: 'send-email' });

  // Step 3: Wait for human response
  // Container exits here, wakes when signal arrives via POST /api/signal/{workflowId}
  console.log('Waiting for approval...');
  const response = await DBOS.recv<{ choice: string; reason?: string }>('approval');

  // Step 4: Process response
  if (!response) {
    return { invoiceId, status: 'timeout' as const };
  }

  if (response.choice === 'approve') {
    await DBOS.runStep(() => markApproved(invoiceId), { name: 'mark-approved' });
    return { invoiceId, status: 'approved' as const };
  } else {
    await DBOS.runStep(() => markRejected(invoiceId, response.reason), { name: 'mark-rejected' });
    return { invoiceId, status: 'rejected' as const, reason: response.reason };
  }
}

const workflow = DBOS.registerWorkflow(approvalWorkflow, { name: 'approval-workflow' });
DBOS.run(workflow);
```

### Child Workflows

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

interface ChildInput {
  parentId: string;
  value: number;
}

async function processChild(value: number) {
  return { result: value * 2 };
}

async function childWorkflow(input: ChildInput) {
  const processed = await DBOS.runStep(() => processChild(input.value), { name: 'process' });
  return {
    parentId: input.parentId,
    inputValue: input.value,
    outputValue: processed.result,
  };
}

const childTask = DBOS.registerWorkflow(childWorkflow, { name: 'child-task' });

async function parentWorkflow(input: { parentId: string; value: number }) {
  console.log('Spawning child workflow...');

  // Start child and wait for result
  const childHandle = await DBOS.startWorkflow(childTask)({
    parentId: input.parentId,
    value: input.value,
  });

  const childResult = await childHandle.getResult();
  console.log(`Child completed: ${childResult.outputValue}`);

  return {
    parentId: input.parentId,
    childResult,
    finalValue: childResult.outputValue + 100,
  };
}

const parent = DBOS.registerWorkflow(parentWorkflow, { name: 'parent-workflow' });
DBOS.run(parent);
```

### Retry with Backoff

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

async function unreliableApiCall(url: string) {
  // This might fail randomly
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function retryWorkflow(input: { url: string }) {
  // Retry up to 5 times with exponential backoff: 1s, 2s, 4s, 8s
  const result = await DBOS.runStep(() => unreliableApiCall(input.url), {
    name: 'api-call',
    retriesAllowed: true,
    maxAttempts: 5,
    intervalSeconds: 1,
    backoffRate: 2,
  });

  return { success: true, data: result };
}

const workflow = DBOS.registerWorkflow(retryWorkflow, { name: 'retry-workflow' });
DBOS.run(workflow);
```

## Step Configuration Options

```typescript
interface StepConfig {
  name?: string; // Step name for tracking/debugging
  retriesAllowed?: boolean; // Enable retries (default: false)
  intervalSeconds?: number; // Initial retry delay (default: 1)
  maxAttempts?: number; // Max retry attempts (default: 3)
  backoffRate?: number; // Retry delay multiplier (default: 2)
}

// Example with full config
await DBOS.runStep(() => myStepFunction(args), {
  name: 'my-step',
  retriesAllowed: true,
  maxAttempts: 10,
  intervalSeconds: 0.5,
  backoffRate: 2,
});
```

## Messaging Between Workflows

### Send a Message

```typescript
// From workflow or external code
await DBOS.send(destinationWorkflowID, { data: 'hello' }, 'my-topic');
```

### Receive a Message

```typescript
// Inside a workflow - container exits if no message, wakes when one arrives
const message = await DBOS.recv<{ data: string }>('my-topic', 60); // 60 second timeout
if (message) {
  console.log('Received:', message.data);
} else {
  console.log('Timeout - no message received');
}
```

## Sending External Signals

From outside the workflow (e.g., a button click, webhook, or curl command):

```bash
# Approve an invoice workflow
curl -X POST "http://localhost:8000/api/signal/{workflowId}?choice=approve&topic=approval"

# With custom message body
curl -X POST "http://localhost:8000/api/signal/{workflowId}" \
  -H "Content-Type: application/json" \
  -d '{"topic": "approval", "message": {"choice": "reject", "reason": "Budget exceeded"}}'
```

## Project Structure

Every SolidSteps workflow project needs a `solidsteps.yaml`:

```yaml
project: my-workflow-project
entrypoint: src/main.ts
```

The SDK reads the project name from this file automatically.

## Common Mistakes to Avoid

### DON'T: Call DBOS methods from inside a step

```typescript
// WRONG - don't call DBOS.sleep() inside a step
async function myStep() {
  await DBOS.sleep(1000); // BAD!
}

// CORRECT - call DBOS.sleep() directly in the workflow
async function myWorkflow() {
  await DBOS.runStep(() => doWork(), { name: 'work' });
  await DBOS.sleep(1000); // GOOD
}
```

### DON'T: Use non-deterministic operations directly in workflow

```typescript
// WRONG - non-deterministic in workflow
async function myWorkflow() {
  const randomId = Math.random(); // BAD - different on replay
  const now = new Date(); // BAD - different on replay
}

// CORRECT - wrap in a step
async function generateId() {
  return Math.random();
}

async function myWorkflow() {
  const randomId = await DBOS.runStep(() => generateId(), { name: 'gen-id' });
}
```

### DON'T: Start workflows from inside a step

```typescript
// WRONG
async function myStep() {
  await DBOS.startWorkflow(otherWorkflow)(input); // BAD!
}

// CORRECT - start from workflow
async function myWorkflow() {
  await DBOS.runStep(() => doPrep(), { name: 'prep' });
  const handle = await DBOS.startWorkflow(otherWorkflow)(input); // GOOD
  await handle.getResult();
}
```

### DON'T: Forget to handle defaults for input

```typescript
// WRONG - will crash if input is empty
async function myWorkflow(input: { taskId: string }) {
  console.log(input.taskId); // undefined if webhook has no body
}

// CORRECT - apply defaults
async function myWorkflow(input: { taskId?: string }) {
  const taskId = input.taskId || 'default-task';
}
```

## Logging

Always log errors like this:

```typescript
DBOS.logger.error(`Error: ${(error as Error).message}`);
DBOS.logger.info('Processing started');
DBOS.logger.debug('Debug details...');
```

## Testing DBOS Functions

For testing workflows:

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

beforeAll(async () => {
  DBOS.setConfig({
    name: 'test-app',
    databaseUrl: process.env.DBOS_TESTING_DATABASE_URL,
  });
  await DBOS.launch();
});

afterAll(async () => {
  await DBOS.shutdown();
});

test('workflow completes successfully', async () => {
  const handle = await DBOS.startWorkflow(myWorkflow)({ taskId: 'test' });
  const result = await handle.getResult();
  expect(result.status).toBe('success');
});
```

---

_SolidSteps SDK - Built on DBOS for container-based durable execution_
_Last updated: 2026-01-12_
