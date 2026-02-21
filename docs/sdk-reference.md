# SolidActions SDK Reference for AI Coding Assistants

This document is the comprehensive reference for the **SolidActions SDK** (`@solidactions/sdk`). It covers the full TypeScript API for building durable, checkpointed workflows.

**For platform deployment, webhook configuration, solidactions.yaml, CLI usage, and environment variables**, see the [platform reference](https://github.com/SolidActions/solidactions) (`docs/platform-reference.md`) in the SolidActions platform repo.

## Single Import Rule

All SDK imports come from one package:

```typescript
import { SolidActions } from '@solidactions/sdk';
```

Additional named exports (when needed):

```typescript
import { SolidActions, SolidActionsClient, ConfiguredInstance } from '@solidactions/sdk';
```

---

## Quick Start

A minimal workflow with two sequential steps:

```typescript
import { SolidActions } from '@solidactions/sdk';

async function greet(name: string): Promise<string> {
  return `Hello, ${name}!`;
}

async function greetingWorkflow(name: string): Promise<string> {
  const greeting = await SolidActions.runStep(() => greet(name), { name: 'greet' });
  SolidActions.logger.info(greeting);
  return greeting;
}

const workflow = SolidActions.registerWorkflow(greetingWorkflow);

// Platform entry point (reads input from WORKFLOW_INPUT env var):
SolidActions.run(greetingWorkflow);
```

---

## Lifecycle

### `SolidActions.run()`

The primary entry point for platform-deployed workflows. Handles `launch()`, `startWorkflow()`, `getResult()`, and `shutdown()` automatically.

```typescript
static async run<T, R>(
  workflow: (input: T) => Promise<R>,
  options?: {
    input?: T;          // Pre-parsed input (overrides WORKFLOW_INPUT)
    workflowID?: string; // Custom workflow ID
  }
): Promise<void>
```

When deployed on the SolidActions platform, `run()` reads the workflow input from the `WORKFLOW_INPUT` environment variable, executes the workflow, and exits the process.

```typescript
import { SolidActions } from '@solidactions/sdk';

async function processOrder(order: { id: string; items: string[] }): Promise<void> {
  await SolidActions.runStep(() => validateOrder(order), { name: 'validate' });
  await SolidActions.runStep(() => chargePayment(order.id), { name: 'charge' });
  await SolidActions.runStep(() => shipOrder(order.id), { name: 'ship' });
}

SolidActions.run(processOrder);
```

### `SolidActions.getInput()`

Reads and parses the `WORKFLOW_INPUT` environment variable. Returns `{}` if the variable is missing or unparseable.

```typescript
static getInput<T = Record<string, unknown>>(): T
```

```typescript
import { SolidActions } from '@solidactions/sdk';

interface MyInput {
  userId: string;
  action: string;
}
const input = SolidActions.getInput<MyInput>();
```

### `SolidActions.setConfig()` / `launch()` / `shutdown()`

Manual lifecycle for local development, testing, or standalone usage. Not needed when using `SolidActions.run()`.

```typescript
static setConfig(config: SolidActionsConfig): void
static async launch(options?: SolidActionsLaunchOptions): Promise<void>
static async shutdown(): Promise<void>
```

```typescript
import { SolidActions } from '@solidactions/sdk';

async function main() {
  SolidActions.setConfig({
    name: 'my-app',
    api: {
      url: process.env.SOLIDACTIONS_API_URL!,
      key: process.env.SOLIDACTIONS_API_KEY!,
    },
  });
  await SolidActions.launch();

  const handle = await SolidActions.startWorkflow(myWorkflow)('arg1');
  const result = await handle.getResult();

  await SolidActions.shutdown();
}

main().catch(console.error);
```

---

## Workflows

### Registering Workflows

#### Functional API (preferred)

```typescript
static registerWorkflow<This, Args extends unknown[], Return>(
  func: (this: This, ...args: Args) => Promise<Return>,
  config?: { name?: string } & WorkflowConfig
): (this: This, ...args: Args) => Promise<Return>
```

```typescript
import { SolidActions } from '@solidactions/sdk';

async function processData(data: string): Promise<string> {
  const cleaned = await SolidActions.runStep(() => cleanData(data), { name: 'clean' });
  const result = await SolidActions.runStep(() => transform(cleaned), { name: 'transform' });
  return result;
}

const processDataWorkflow = SolidActions.registerWorkflow(processData);
```

#### Decorator API (class-based)

```typescript
@SolidActions.workflow(config?: WorkflowConfig)
```

```typescript
import { SolidActions } from '@solidactions/sdk';

class DataProcessor {
  @SolidActions.workflow()
  static async processData(data: string): Promise<string> {
    const cleaned = await SolidActions.runStep(() => cleanData(data), { name: 'clean' });
    return cleaned;
  }
}
```

### WorkflowConfig

```typescript
interface WorkflowConfig {
  maxRecoveryAttempts?: number; // Default: 100
  name?: string; // Override the workflow function name
}
```

### Determinism Rules

Workflow functions **must be deterministic**: given the same inputs, they must invoke the same steps in the same order. All non-deterministic operations must be inside steps:

**Do NOT do this in a workflow function:**

- HTTP requests (`fetch`, API calls)
- File system access
- Random number generation (use `SolidActions.randomUUID()` or wrap in a step)
- Get current time (use `SolidActions.now()` or wrap in a step)
- Access databases

**Safe inside workflow functions:**

- Loops, branches, conditionals (deterministic logic)
- Calling `SolidActions.runStep()`
- Calling `SolidActions.sleep()`, `SolidActions.send()`, `SolidActions.recv()`
- Calling `SolidActions.setEvent()`, `SolidActions.getEvent()`
- Calling `SolidActions.now()`, `SolidActions.randomUUID()`
- Calling `SolidActions.startWorkflow()`

### Workflow IDs and Idempotency

Every workflow execution gets a unique ID (UUID by default). You can assign a custom ID via `SolidActions.startWorkflow()`. A custom workflow ID acts as an **idempotency key**: calling a workflow with the same ID multiple times executes it only once.

```typescript
import { SolidActions } from '@solidactions/sdk';

async function chargeCustomer(customerId: string, amount: number): Promise<void> {
  await SolidActions.runStep(() => processPayment(customerId, amount), { name: 'charge' });
}
const chargeWorkflow = SolidActions.registerWorkflow(chargeCustomer);

// Idempotent: even if called twice, charges only once
const handle = await SolidActions.startWorkflow(chargeWorkflow, {
  workflowID: `charge-${orderId}`,
})(customerId, amount);
```

### Workflow Timeouts

Set a timeout via `SolidActions.startWorkflow()`. When the timeout expires, the workflow and all its children are cancelled. Timeouts are **start-to-completion** and **durable** (persist across restarts).

```typescript
import { SolidActions } from '@solidactions/sdk';

const handle = await SolidActions.startWorkflow(myWorkflow, {
  timeoutMS: 60000, // 60 seconds
})('input');
```

### Starting Workflows in the Background

Use `SolidActions.startWorkflow()` to start a workflow in the background and get a `WorkflowHandle`:

```typescript
static startWorkflow<Args extends unknown[], Return>(
  target: (...args: Args) => Promise<Return>,
  params?: StartWorkflowParams
): (...args: Args) => Promise<WorkflowHandle<Return>>
```

`StartWorkflowParams`:

- `workflowID?: string` — Custom workflow ID (acts as idempotency key)
- `timeoutMS?: number` — Timeout in milliseconds

```typescript
import { SolidActions } from '@solidactions/sdk';

async function parentWorkflow(): Promise<void> {
  // Start child workflow in background
  const handle = await SolidActions.startWorkflow(childWorkflow)('arg1');

  // Do other work...
  await SolidActions.runStep(() => doSomethingElse(), { name: 'other' });

  // Wait for child result
  const childResult = await handle.getResult();
}
```

### Retrieving a Workflow by ID

```typescript
static retrieveWorkflow<T = unknown>(workflowID: string): WorkflowHandle<Awaited<T>>
```

```typescript
import { SolidActions } from '@solidactions/sdk';

const handle = SolidActions.retrieveWorkflow<string>('my-workflow-id');
const status = await handle.getStatus();
const result = await handle.getResult();
```

---

## Steps

Steps are the building blocks of workflows. They wrap ordinary functions and provide checkpointing — if a workflow is interrupted, it resumes from the last completed step.

### `SolidActions.runStep()` (preferred)

```typescript
static runStep<Return>(
  func: () => Promise<Return>,
  config?: StepConfig & { name?: string }
): Promise<Return>
```

```typescript
import { SolidActions } from '@solidactions/sdk';

async function myWorkflow(): Promise<void> {
  const data = await SolidActions.runStep(() => fetchFromApi(), { name: 'fetchData' });
  await SolidActions.runStep(() => saveToDb(data), { name: 'saveData' });
}
```

### `SolidActions.registerStep()` (alternative)

```typescript
static registerStep<This, Args extends unknown[], Return>(
  func: (this: This, ...args: Args) => Promise<Return>,
  config?: StepConfig & { name?: string }
): (this: This, ...args: Args) => Promise<Return>
```

```typescript
import { SolidActions } from '@solidactions/sdk';

async function fetchData(url: string): Promise<string> {
  return await fetch(url).then((r) => r.text());
}
const fetchStep = SolidActions.registerStep(fetchData, { name: 'fetchData' });

async function myWorkflow(url: string): Promise<string> {
  return await fetchStep(url);
}
```

### `@SolidActions.step()` Decorator (alternative)

```typescript
import { SolidActions } from '@solidactions/sdk';

class MyService {
  @SolidActions.step()
  static async fetchData(url: string): Promise<string> {
    return await fetch(url).then((r) => r.text());
  }

  @SolidActions.workflow()
  static async processUrl(url: string): Promise<string> {
    return await MyService.fetchData(url);
  }
}
```

### StepConfig

```typescript
interface StepConfig {
  retriesAllowed?: boolean; // Enable automatic retries (default: false)
  intervalSeconds?: number; // Seconds before first retry (default: 1)
  maxAttempts?: number; // Maximum retry attempts (default: 3)
  backoffRate?: number; // Retry interval multiplier (default: 2)
  name?: string; // Step name for identification
}
```

Example with retries:

```typescript
import { SolidActions } from '@solidactions/sdk';

async function myWorkflow(): Promise<string> {
  return await SolidActions.runStep(() => callUnreliableApi(), {
    name: 'callApi',
    retriesAllowed: true,
    maxAttempts: 5,
    intervalSeconds: 2,
    backoffRate: 3,
  });
}
```

### Parallel Step Execution

Use `Promise.allSettled()` to run steps in parallel. Steps must be **started in a deterministic order** (the array literal order is deterministic):

```typescript
import { SolidActions } from '@solidactions/sdk';

async function parallelWorkflow(): Promise<void> {
  // CORRECT: steps started in deterministic order
  const results = await Promise.allSettled([
    SolidActions.runStep(() => fetchUserProfile(userId), { name: 'profile' }),
    SolidActions.runStep(() => fetchUserOrders(userId), { name: 'orders' }),
    SolidActions.runStep(() => fetchUserPrefs(userId), { name: 'prefs' }),
  ]);
}
```

**Do NOT use `Promise.all()`** — when any promise rejects, `Promise.all` immediately fails, leaving other promises unresolved. If one of those later throws, it crashes the Node.js process. Always use `Promise.allSettled()`.

**Do NOT nest async functions in `Promise.allSettled()`** — the execution order of steps inside nested async functions is non-deterministic:

```typescript
// WRONG: step2 and step4 may execute in either order
const results = await Promise.allSettled([
  async () => {
    await step1();
    await step2();
  },
  async () => {
    await step3();
    await step4();
  },
]);
```

For sequences of operations in parallel, use child workflows via `SolidActions.startWorkflow()`.

---

## Durable Primitives

### `SolidActions.sleep()` / `sleepms()` / `sleepSeconds()`

Durable sleep that persists across restarts. The wakeup time is saved so the workflow always wakes on schedule.

```typescript
static async sleep(durationMS: number): Promise<void>
static async sleepms(durationMS: number): Promise<void>
static async sleepSeconds(durationSec: number): Promise<void>
```

```typescript
import { SolidActions } from '@solidactions/sdk';

async function reminderWorkflow(userId: string): Promise<void> {
  await SolidActions.runStep(() => sendInitialEmail(userId), { name: 'sendEmail' });
  await SolidActions.sleep(86400000); // Sleep 24 hours (durable)
  await SolidActions.runStep(() => sendFollowUp(userId), { name: 'followUp' });
}
```

### `SolidActions.now()`

Returns the current time as a UNIX epoch timestamp in milliseconds. Deterministic — on recovery, returns the same value that was recorded during the original execution.

```typescript
static async now(): Promise<number>
```

```typescript
import { SolidActions } from '@solidactions/sdk';

async function timedWorkflow(): Promise<void> {
  const startTime = await SolidActions.now();
  await SolidActions.runStep(() => doWork(), { name: 'work' });
  const endTime = await SolidActions.now();
  SolidActions.logger.info(`Elapsed: ${endTime - startTime}ms`);
}
```

### `SolidActions.randomUUID()`

Generates a deterministic UUID. On recovery, returns the same UUID that was generated during the original execution.

```typescript
static async randomUUID(): Promise<string>
```

```typescript
import { SolidActions } from '@solidactions/sdk';

async function createEntityWorkflow(name: string): Promise<string> {
  const entityId = await SolidActions.randomUUID();
  await SolidActions.runStep(() => saveEntity(entityId, name), { name: 'save' });
  return entityId;
}
```

---

## Communication

### Messaging: `send()` / `recv()`

Send messages to a workflow by its ID. Messages are queued per topic.

```typescript
static async send<T>(
  destinationID: string,
  message: T,
  topic?: string,
  idempotencyKey?: string
): Promise<void>

static async recv<T>(
  topic?: string,
  timeoutSeconds?: number
): Promise<T | null>
```

- `send()` can be called from anywhere (workflow, step, or outside via `SolidActionsClient`).
- `recv()` can only be called from a workflow function (not from steps).
- Messages without a topic are separate from messages with topics.
- `recv()` returns `null` if the timeout expires.
- All messages are persisted — if `send` completes, the receiver is guaranteed to get it.

```typescript
import { SolidActions } from '@solidactions/sdk';

// Approval workflow: waits for an external signal
async function approvalWorkflow(requestId: string): Promise<string> {
  await SolidActions.runStep(() => sendApprovalRequest(requestId), { name: 'requestApproval' });

  // Wait up to 24 hours for approval
  const decision = await SolidActions.recv<string>('approval', 86400);
  if (decision === 'approved') {
    await SolidActions.runStep(() => executeRequest(requestId), { name: 'execute' });
    return 'completed';
  }
  return 'rejected';
}

// External caller sends approval:
await SolidActions.send(workflowID, 'approved', 'approval');
```

### Events: `setEvent()` / `getEvent()`

Publish key-value pairs from within a workflow. Useful for status updates or communicating intermediate results.

```typescript
static async setEvent<T>(key: string, value: T): Promise<void>

static async getEvent<T>(
  workflowID: string,
  key: string,
  timeoutSeconds?: number
): Promise<T | null>
```

- `setEvent()` can only be called from a workflow function (not from steps).
- `getEvent()` can be called from anywhere.
- Events are persisted and the latest value is always retrievable.
- `getEvent()` waits for the event to be published, returning `null` on timeout.

```typescript
import { SolidActions } from '@solidactions/sdk';

async function checkoutWorkflow(orderId: string): Promise<void> {
  const paymentUrl = await SolidActions.runStep(() => createPaymentSession(orderId), { name: 'createPayment' });

  // Publish payment URL for the caller
  await SolidActions.setEvent('paymentUrl', paymentUrl);

  // Wait for payment confirmation
  const confirmation = await SolidActions.recv<string>('paymentComplete', 3600);
  if (confirmation) {
    await SolidActions.runStep(() => fulfillOrder(orderId), { name: 'fulfill' });
  }
}

// Caller reads the payment URL:
const url = await SolidActions.getEvent<string>(handle.workflowID, 'paymentUrl', 30);
```

### Streaming: `writeStream()` / `readStream()` / `closeStream()`

Stream data in real time from workflows to clients. Useful for LLM streaming, progress reporting, or long-running result feeds.

```typescript
static async writeStream<T>(key: string, value: T): Promise<void>
static async closeStream(key: string): Promise<void>
static async *readStream<T>(workflowID: string, key: string): AsyncGenerator<T, void, unknown>
```

- `writeStream()` can be called from workflows or steps.
- `readStream()` can be called from anywhere.
- Streams are immutable and append-only.
- Writes from a workflow happen exactly-once. Writes from a step happen at-least-once (retried steps may write duplicates).
- Streams are automatically closed when the workflow terminates.

```typescript
import { SolidActions } from '@solidactions/sdk';

async function streamingWorkflow(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const result = await SolidActions.runStep(() => processChunk(i), { name: `chunk-${i}` });
    await SolidActions.writeStream('progress', { step: i, result });
  }
  await SolidActions.closeStream('progress');
}

// Reader:
for await (const value of SolidActions.readStream(workflowID, 'progress')) {
  console.log(`Progress: ${JSON.stringify(value)}`);
}
```

### `SolidActions.respond()`

Sends an early response body to the external caller. Used in webhook wait-mode workflows to return a response before the workflow completes.

```typescript
static async respond(body: unknown): Promise<void>
```

- Can only be called from a workflow function (not from steps).
- The body is sent back to the HTTP caller that triggered the webhook.
- Must be called while the webhook request is still waiting (within the webhook timeout).

```typescript
import { SolidActions } from '@solidactions/sdk';

async function webhookWorkflow(input: { query: string }): Promise<void> {
  const quickResult = await SolidActions.runStep(() => fastLookup(input.query), { name: 'lookup' });

  // Send early response to the waiting HTTP caller
  await SolidActions.respond({ status: 'ok', data: quickResult });

  // Continue with slower background processing
  await SolidActions.runStep(() => heavyProcessing(input.query), { name: 'process' });
}
```

### `SolidActions.getSignalUrls()`

Generates pre-built signal URLs for the current workflow. Useful for approval workflows where external users need clickable approve/reject links.

```typescript
static getSignalUrls(topic?: string): {
  base: string;
  approve: string;
  reject: string;
  custom: (action: string) => string;
}
```

- Must be called from within a workflow.
- Returns URLs that send signals to the current workflow via the platform's signal API.

```typescript
import { SolidActions } from '@solidactions/sdk';

async function approvalWorkflow(request: { id: string }): Promise<void> {
  const urls = SolidActions.getSignalUrls('approval');

  await SolidActions.runStep(
    () =>
      sendEmail({
        to: 'manager@example.com',
        body: `Approve: ${urls.approve}\nReject: ${urls.reject}`,
      }),
    { name: 'notifyManager' },
  );

  const decision = await SolidActions.recv<string>('approval', 86400);
  // decision will be 'approve' or 'reject' based on which URL was clicked
}
```

---

## Workflow Handles

A `WorkflowHandle<R>` represents an active or completed workflow execution.

```typescript
interface WorkflowHandle<R> {
  get workflowID(): string;
  getStatus(): Promise<WorkflowStatus | null>;
  getResult(): Promise<R>;
  getWorkflowInputs<T extends any[]>(): Promise<T>;
}
```

### `handle.workflowID`

The unique ID of the workflow execution.

### `handle.getResult()`

Waits for the workflow to complete, then returns its result. Throws if the workflow errors.

### `handle.getStatus()`

Returns the current `WorkflowStatus` (see below).

### `handle.getWorkflowInputs()`

Returns the deserialized arguments that were passed to the workflow function.

### WorkflowStatus

```typescript
interface WorkflowStatus {
  readonly workflowID: string;
  readonly status: string; // PENDING | SUCCESS | ERROR | CANCELLED | ENQUEUED | MAX_RECOVERY_ATTEMPTS_EXCEEDED
  readonly workflowName: string;
  readonly workflowClassName: string;
  readonly workflowConfigName?: string;
  readonly input?: unknown[];
  readonly output?: unknown;
  readonly error?: unknown;
  readonly executorId?: string;
  readonly applicationVersion?: string;
  readonly recoveryAttempts?: number;
  readonly createdAt: number; // UNIX epoch ms
  readonly updatedAt?: number; // UNIX epoch ms
  readonly timeoutMS?: number;
  readonly deadlineEpochMS?: number;
  readonly applicationID: string;
}
```

---

## Context Variables

These are accessible from within workflows and steps:

```typescript
SolidActions.workflowID: string | undefined   // Current workflow ID
SolidActions.runID: string | undefined         // Current run ID
SolidActions.stepID: number | undefined        // Current step ID within the workflow
SolidActions.stepStatus: StepStatus | undefined // Current step retry info
SolidActions.logger: DLogger                    // Logger instance
```

### StepStatus

```typescript
interface StepStatus {
  stepID: number;
  currentAttempt?: number; // Zero-indexed retry attempt
  maxAttempts?: number; // Total allowed attempts
}
```

```typescript
import { SolidActions } from '@solidactions/sdk';

async function myWorkflow(): Promise<void> {
  SolidActions.logger.info(`Workflow ${SolidActions.workflowID} started`);
  await SolidActions.runStep(() => doWork(), { name: 'work' });
}
```

---

## Workflow Management

### `SolidActions.getWorkflowStatus()`

```typescript
static getWorkflowStatus(workflowID: string): Promise<WorkflowStatus | null>
```

### `SolidActions.getResult()`

```typescript
static async getResult<T>(workflowID: string, timeoutSeconds?: number): Promise<T | null>
```

### `SolidActions.listWorkflows()`

```typescript
static async listWorkflows(input: GetWorkflowsInput): Promise<WorkflowStatus[]>
```

```typescript
interface GetWorkflowsInput {
  workflowIDs?: string[];
  workflowName?: string;
  status?: 'PENDING' | 'SUCCESS' | 'ERROR' | 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' | 'CANCELLED' | 'ENQUEUED';
  startTime?: string; // RFC 3339 timestamp
  endTime?: string; // RFC 3339 timestamp
  applicationVersion?: string;
  limit?: number;
  offset?: number;
  sortDesc?: boolean;
}
```

```typescript
import { SolidActions } from '@solidactions/sdk';

const pendingWorkflows = await SolidActions.listWorkflows({
  status: 'PENDING',
  limit: 50,
  sortDesc: true,
});
```

### `SolidActions.listWorkflowSteps()`

```typescript
static async listWorkflowSteps(workflowID: string): Promise<StepInfo[] | undefined>
```

```typescript
interface StepInfo {
  readonly functionID: number; // Zero-indexed step ID
  readonly name: string;
  readonly output: unknown;
  readonly error: Error | null;
  readonly childWorkflowID: string | null;
  readonly startedAtEpochMs?: number;
  readonly completedAtEpochMs?: number;
}
```

### `SolidActions.cancelWorkflow()`

Cancels a workflow. Sets status to `CANCELLED` and preempts execution at the next step boundary.

```typescript
static async cancelWorkflow(workflowID: string): Promise<void>
```

### `SolidActions.resumeWorkflow()`

Resumes a cancelled or failed workflow from its last completed step.

```typescript
static async resumeWorkflow<T>(workflowID: string): Promise<WorkflowHandle<Awaited<T>>>
```

### `SolidActions.forkWorkflow()`

Starts a new execution of a workflow from a specific step. Useful for patching failed workflows on a new code version.

```typescript
static async forkWorkflow<T>(
  workflowID: string,
  startStep: number,
  options?: {
    newWorkflowID?: string;
    applicationVersion?: string;
    timeoutMS?: number;
  }
): Promise<WorkflowHandle<Awaited<T>>>
```

```typescript
import { SolidActions } from '@solidactions/sdk';

// Fork a failed workflow from step 3, running on current code version
const handle = await SolidActions.forkWorkflow('failed-wf-id', 3);
const result = await handle.getResult();
```

---

## Versioning and Recovery

SolidActions versions applications by hashing workflow source code at launch. Workflows are tagged with the version on which they started. During recovery, only workflows matching the current version are recovered — this prevents unsafe recovery of workflows that depend on different code.

You can override the version via `applicationVersion` in `SolidActionsConfig`.

### `SolidActions.patch()` / `SolidActions.deprecatePatch()`

Used for safe code evolution. `patch()` returns `true` if the named patch is active, allowing conditional logic based on code version.

```typescript
static async patch(patchName: string): Promise<boolean>
static async deprecatePatch(patchName: string): Promise<boolean>
```

---

## ConfiguredInstance

For class-based workflows where instances need configuration and state:

```typescript
import { SolidActions, ConfiguredInstance } from '@solidactions/sdk';

class EmailService extends ConfiguredInstance {
  private apiKey: string;

  constructor(name: string, apiKey: string) {
    super(name);
    this.apiKey = apiKey;
  }

  override async initialize(): Promise<void> {
    // Validate configuration — called during SolidActions.launch()
  }

  @SolidActions.workflow()
  async sendEmailWorkflow(to: string, subject: string): Promise<void> {
    await SolidActions.runStep(() => this.sendEmail(to, subject), { name: 'send' });
  }

  private async sendEmail(to: string, subject: string): Promise<void> {
    // Use this.apiKey to send email
  }
}

// Must instantiate before SolidActions.launch()
const emailService = new EmailService('primary-email', process.env.EMAIL_API_KEY!);
```

Use `@SolidActions.className(name)` to set a custom class name for the registry:

```typescript
@SolidActions.className('email-svc')
class EmailService extends ConfiguredInstance { ... }
```

**Prefer `registerWorkflow` with plain functions over `ConfiguredInstance` when possible.** Use `ConfiguredInstance` only when you need instance-level configuration.

---

## SolidActionsClient

A standalone HTTP client for querying and interacting with workflows from outside the SDK runtime. Useful for external services, API servers, or monitoring tools.

```typescript
import { SolidActionsClient } from '@solidactions/sdk';

const client = SolidActionsClient.create({
  httpConfig: {
    apiUrl: process.env.SOLIDACTIONS_API_URL!,
    apiKey: process.env.SOLIDACTIONS_API_KEY!,
  },
});
```

### Methods

```typescript
// Retrieve a workflow handle
client.retrieveWorkflow<T>(workflowID: string): WorkflowHandle<Awaited<T>>

// Send a message to a workflow
client.send<T>(destinationID: string, message: T, topic?: string, idempotencyKey?: string): Promise<void>

// Get a workflow event
client.getEvent<T>(workflowID: string, key: string, timeoutSeconds?: number): Promise<T | null>

// Cancel a workflow
client.cancelWorkflow(workflowID: string): Promise<void>

// Resume a workflow
client.resumeWorkflow(workflowID: string): Promise<void>

// Fork a workflow
client.forkWorkflow(workflowID: string, startStep: number, options?: { newWorkflowID?: string; applicationVersion?: string; timeoutMS?: number }): Promise<string>

// Get workflow status
client.getWorkflow(workflowID: string): Promise<WorkflowStatus | undefined>

// List workflows
client.listWorkflows(input: GetWorkflowsInput): Promise<WorkflowStatus[]>

// List workflow steps
client.listWorkflowSteps(workflowID: string): Promise<StepInfo[] | undefined>

// Read a stream
client.readStream<T>(workflowID: string, key: string): AsyncGenerator<T, void, unknown>

// Clean up
client.destroy(): Promise<void>
```

```typescript
import { SolidActionsClient } from '@solidactions/sdk';

const client = SolidActionsClient.create({
  httpConfig: {
    apiUrl: 'https://app.solidactions.com/api/internal',
    apiKey: 'sa_key_...',
  },
});

// Check workflow status
const status = await client.getWorkflow('wf-123');
console.log(status?.status); // 'SUCCESS'

// Send approval signal
await client.send('wf-456', 'approved', 'approval');

// Stream results
for await (const chunk of client.readStream('wf-789', 'output')) {
  console.log(chunk);
}

await client.destroy();
```

---

## Configuration

### SolidActionsConfig

Passed to `SolidActions.setConfig()`:

```typescript
interface SolidActionsConfig {
  name?: string; // Application name

  api?: {
    url: string; // Base API URL
    key: string; // API key / Bearer token
    timeout?: number; // Request timeout in ms (default: 30000)
    maxRetries?: number; // Max retry attempts (default: 3)
  };

  enableOTLP?: boolean; // Enable OpenTelemetry (default: false)
  logLevel?: string; // Log level (default: 'info')
  otlpTracesEndpoints?: string[]; // OTLP trace receivers
  otlpLogsEndpoints?: string[]; // OTLP log receivers

  runAdminServer?: boolean; // Run admin HTTP server (default: true)
  adminPort?: number; // Admin server port (default: 3001)

  applicationVersion?: string; // Override auto-computed version
}
```

**Note:** There is no `systemDatabaseUrl`. The SDK communicates with the SolidActions platform via HTTP API (`api.url` and `api.key`).

---

## Custom Serialization

Register custom serializers for non-JSON-serializable types:

```typescript
static registerSerialization<T, S extends JSONValue>(recipe: SerializationRecipe<T, S>): void
```

```typescript
interface SerializationRecipe<T, S> {
  name: string;
  isApplicable: (v: unknown) => v is T;
  serialize: (v: T) => S;
  deserialize: (s: S) => T;
}
```

```typescript
import { SolidActions } from '@solidactions/sdk';

SolidActions.registerSerialization({
  name: 'BigInt',
  isApplicable: (v): v is bigint => typeof v === 'bigint',
  serialize: (v) => v.toString(),
  deserialize: (s) => BigInt(s),
});
```

---

## Logging

Use `SolidActions.logger` for structured logging within workflows and steps:

```typescript
import { SolidActions } from '@solidactions/sdk';

SolidActions.logger.info('Processing started');
SolidActions.logger.warn('Rate limit approaching');
SolidActions.logger.error(`Error: ${(error as Error).message}`);
SolidActions.logger.debug('Step details', { stepId: SolidActions.stepID });
```

---

## Testing

Use Jest or Vitest with `setConfig`/`launch`/`shutdown` for test isolation:

```typescript
import { SolidActions } from '@solidactions/sdk';

beforeAll(async () => {
  SolidActions.setConfig({
    name: 'test-app',
    api: {
      url: process.env.SOLIDACTIONS_API_URL!,
      key: process.env.SOLIDACTIONS_API_KEY!,
    },
  });
  await SolidActions.launch();
});

afterAll(async () => {
  await SolidActions.shutdown();
});
```

For test isolation of event receivers:

```typescript
import { SolidActions } from '@solidactions/sdk';

beforeEach(async () => {
  await SolidActions.deactivateEventReceivers();
});

afterEach(async () => {
  await SolidActions.initEventReceivers();
});
```

---

## Error Classes

All SDK errors extend `SolidActionsError`:

```typescript
import { SolidActionsError } from '@solidactions/sdk';
```

| Error Class                                    | When Thrown                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `SolidActionsWorkflowConflictError`            | Workflow ID already exists with different code                |
| `SolidActionsMaxStepRetriesError`              | Step exceeded maximum retry attempts (has `.errors: Error[]`) |
| `SolidActionsWorkflowCancelledError`           | Workflow was cancelled (has `.workflowID: string`)            |
| `SolidActionsMaxRecoveryAttemptsExceededError` | Workflow exceeded max recovery attempts                       |
| `SolidActionsNotRegisteredError`               | Referenced workflow/step not registered                       |
| `SolidActionsInitializationError`              | SDK failed to initialize                                      |
| `SolidActionsNonExistentWorkflowError`         | Workflow ID not found                                         |
| `SolidActionsConflictingRegistrationError`     | Duplicate workflow/step name                                  |
| `SolidActionsUnexpectedStepError`              | Step executed in wrong order during recovery                  |
| `SolidActionsAwaitedWorkflowCancelledError`    | Awaited child workflow was cancelled                          |
| `SolidActionsHttpError`                        | HTTP communication error (base class)                         |
| `SolidActionsUnauthorizedError`                | 401 response                                                  |
| `SolidActionsForbiddenError`                   | 403 response                                                  |
| `SolidActionsNotFoundError`                    | 404 response                                                  |
| `SolidActionsRateLimitedError`                 | 429 response (has `.retryAfterSeconds?: number`)              |
| `SolidActionsServerError`                      | 5xx response                                                  |
| `SolidActionsNetworkError`                     | Network connectivity failure                                  |

---

## Rules for AI Consumers

### Do

- Import everything from `@solidactions/sdk`
- Use `SolidActions.runStep()` for all non-deterministic operations
- Use `SolidActions.run()` as the entry point for platform workflows
- Use `Promise.allSettled()` for parallel step execution
- Keep workflow functions deterministic
- Use `SolidActions.now()` instead of `Date.now()` in workflows
- Use `SolidActions.randomUUID()` instead of `crypto.randomUUID()` in workflows
- Use `SolidActions.sleep()` instead of `setTimeout` for delays
- Fully type all workflow and step function signatures
- Await all promises

### Do Not

- Do not call context methods (`send`, `recv`, `setEvent`, `getEvent`, `sleep`, `startWorkflow`) from inside a step
- Do not start workflows from inside a step
- Do not use `Promise.all()` — use `Promise.allSettled()`
- Do not perform non-deterministic operations directly in workflow functions
- Do not use `systemDatabaseUrl` — the SDK uses HTTP API configuration
- Do not reference `WorkflowQueue`, `Debouncer`, `registerScheduled`, or `@SolidActions.scheduled()` — these features do not exist
- Do not import from `@dbos-inc/dbos-sdk` — use `@solidactions/sdk`
- Do not reference `Toolbox`, `koaContext`, `getApi`, `postApi`, or `SolidActions Transact`
- Do not create or update global variables from workflows or steps
- Do not call `SolidActions.setEvent` or `SolidActions.recv` from outside a workflow function
