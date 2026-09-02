# SolidActions SDK Reference for AI Coding Assistants

This document is the comprehensive reference for the **SolidActions SDK** (`@solidactions/sdk`). It covers the full TypeScript API for building durable, checkpointed workflows.

**For platform deployment, webhook configuration, `solidactions.yaml`, CLI usage, and variables**, see the scaffolded `solidactions-deploy-and-config` skill (`.claude/skills/` or `.agents/skills/`) and the public examples repo: https://github.com/SolidActions/solidactions-examples.

## The Workflow Contract

A SolidActions workflow is a **descriptor** created with `defineWorkflow` and exported from your module:

```typescript
import { SolidActions, defineWorkflow } from '@solidactions/sdk';

export const myWorkflow = defineWorkflow<Input, Output>({
  name: 'my-workflow',
  run: (ctx) => /* ... use ctx.input, ctx.vars, and SolidActions.* ... */,
});
```

The `run` function receives a single **context object** (`ctx`) carrying the request's input, tenant variables, and run/app identity. The platform (or the CLI) loads your module, finds the exported descriptor, and invokes `run(ctx)` once per request. **You do not call an entry-point function** — exporting the descriptor is the entire wiring.

> **Migrating from the old API?** `SolidActions.run()`, `SolidActions.registerWorkflow()`, and `SolidActions.getInput()` are the pre-`ctx` model. They still work but are legacy — see [Legacy and Migration](#legacy-and-migration). New code should use `defineWorkflow` + `ctx`.

## Single Import Rule

All SDK imports come from one package:

```typescript
import { SolidActions, defineWorkflow } from '@solidactions/sdk';
```

Additional named exports (when needed):

```typescript
import { SolidActions, defineWorkflow, SolidActionsClient, ConfiguredInstance } from '@solidactions/sdk';

// Types:
import type { InvokeCtx, WorkflowDescriptor, ConnectionVar, VarValue, InvokeResult } from '@solidactions/sdk';
```

---

## Quick Start

A minimal workflow with two sequential steps:

```typescript
import { SolidActions, defineWorkflow } from '@solidactions/sdk';

interface GreetInput {
  name: string;
}

// A step function — ordinary async logic, wrapped by SolidActions.runStep below.
async function greet(name: string): Promise<string> {
  return `Hello, ${name}!`;
}

// Export the descriptor. The platform loads this module and runs `run(ctx)`.
export const greetingWorkflow = defineWorkflow<GreetInput, string>({
  name: 'greeting',
  async run(ctx) {
    const greeting = await SolidActions.runStep(() => greet(ctx.input.name), { name: 'greet' });
    SolidActions.logger.info(greeting);
    return greeting;
  },
});
```

The typical shape separates the orchestration function from the descriptor wrapper. The wrapper maps `ctx` onto a plain typed function:

```typescript
import { SolidActions, defineWorkflow } from '@solidactions/sdk';

interface OrderInput {
  id: string;
  items: string[];
}

async function processOrder(order: OrderInput): Promise<void> {
  await SolidActions.runStep(() => validateOrder(order), { name: 'validate' });
  await SolidActions.runStep(() => chargePayment(order.id), { name: 'charge' });
  await SolidActions.runStep(() => shipOrder(order.id), { name: 'ship' });
}

export const orderWorkflow = defineWorkflow<OrderInput, void>({
  name: 'process-order',
  run: (ctx) => processOrder(ctx.input),
});
```

---

## `defineWorkflow`

```typescript
function defineWorkflow<I, O>(def: WorkflowDescriptor<I, O>): WorkflowDescriptor<I, O>;

interface WorkflowDescriptor<I = unknown, O = unknown> {
  run: (ctx: InvokeCtx<I> & DurablePrimitives) => Promise<O>;
  name?: string;
}
```

`defineWorkflow` validates the descriptor, registers it in a process-global registry, and returns it annotated with its resolved name. **Importing a module that calls `defineWorkflow` is side-effect-free** with respect to execution: it reads no environment, writes no status, never calls `process.exit`, and emits no warnings. The only observable effect is the registry entry.

### Name resolution

The registration name is resolved in this order:

1. Explicit `name` (wins) — e.g. `{ name: 'my-workflow', run }`
2. The `run` function's declaration name — e.g. `async run(ctx) { … }` registers as `run`
3. Otherwise **throws** — an anonymous arrow (`run: (ctx) => …`) with no `name` is rejected.

**Always pass an explicit `name`.** It is the stable identifier used for child-workflow dispatch and platform routing, and it decouples registration from the function's JavaScript name.

### Typing the input and output

`defineWorkflow<I, O>` types both `ctx.input` (as `I`) and the `run` return value (as `O`). Fully annotate both so callers and child-workflow dispatch are type-checked.

---

## The Context Object (`ctx`)

Every `run(ctx)` receives an `InvokeCtx`. It is the single, explicit source of per-run identity, input, and tenant configuration — the SDK reads **no** `process.env` or module globals on this path.

```typescript
interface InvokeCtx<I = unknown> {
  input: I;
  vars: Readonly<Record<string, VarValue> & InvokeCtxVarsAugment>;
  run: InvokeCtxRun;
  app: InvokeCtxApp;
  api: { url: string; key: string };
  workflowSlug?: string;
  telemetry?: { enabled: boolean };
  mode: 'resident' | 'oneshot' | 'local';
}
```

### `ctx.input`

The typed, pre-parsed workflow input. This **replaces `SolidActions.getInput()`** — the platform deserializes the request body and hands it to you directly as `ctx.input`.

```typescript
export const wf = defineWorkflow<{ userId: string }, void>({
  name: 'example',
  async run(ctx) {
    const { userId } = ctx.input;
    // ...
  },
});
```

### `ctx.vars` — tenant variables and connections

`ctx.vars` is the **single source of truth** for the project's declared variables (declared in the `env:` block of `solidactions.yaml`). As of v0.6.0, tenant variables are exposed **only** through `ctx.vars` — they are no longer leaked into `process.env`, and container base environment (`PATH`, `HOME`, …) no longer pollutes the var set.

Each value is a `VarValue`:

```typescript
type VarValue = string | ConnectionVar;

interface ConnectionVar {
  readonly key: string; // opaque connection key
  readonly proxyUrl: string; // run-shared proxy endpoint
  readonly proxyToken: string; // bearer token — treat as a secret
  readonly broker?: ConnectionBroker; // 'pica' (supported); 'composio' is deprecated
}
```

- **Plain string vars** (env values, secrets mapped from globals) arrive as `string`.
- **OAuth / API connections** arrive as a `ConnectionVar`. You make authenticated requests through `proxyUrl` using `proxyToken` — the broker injects credentials so the workflow never handles the underlying secret. The `pica` proxy is the supported contract; `composio` is deprecated.

```typescript
export const oauthWorkflow = defineWorkflow<{ repo: string }, void>({
  name: 'oauth-example',
  async run(ctx) {
    const flag = ctx.vars.MY_FLAG as string | undefined;
    const gh = ctx.vars.GITHUB as ConnectionVar | undefined;

    if (gh) {
      await SolidActions.runStep(
        () =>
          fetch(`${gh.proxyUrl}/repos/${ctx.input.repo}`, {
            headers: { Authorization: `Bearer ${gh.proxyToken}` },
          }),
        { name: 'call-github' },
      );
    }
  },
});
```

#### Typed `ctx.vars`

Without extra typing, `ctx.vars` is the permissive `Record<string, VarValue>`, so accesses need a cast (`ctx.vars.MY_FLAG as string`). The SDK exposes a declaration-merging hook, `InvokeCtxVarsAugment`, that projects can extend so `ctx.vars` is precisely typed:

```typescript
// vars.d.ts — augments the SDK's empty hook interface
import type { ConnectionVar } from '@solidactions/sdk';

declare module '@solidactions/sdk' {
  interface InvokeCtxVarsAugment {
    MY_FLAG: string;
    GITHUB: ConnectionVar;
  }
}
```

With this file present, `ctx.vars.MY_FLAG` is `string` and `ctx.vars.GITHUB` is `ConnectionVar` — no casts. The interface is intersected with `Record<string, VarValue>`, so undeclared keys still resolve to `VarValue` and existing code keeps compiling.

### `ctx.run` — run identity

```typescript
interface InvokeCtxRun {
  triggerId: string | number; // the trigger that started this run
  runUuid: string; // unique id of this run
  runSecret: string; // per-run secret — treat as a secret
  workerSessionId: string; // worker session that executed the run
}
```

### `ctx.app` — application identity

```typescript
interface InvokeCtxApp {
  appVersion: string;
  appId: string;
  tenantId: string;
}
```

### `ctx.api`, `ctx.mode`, `ctx.workflowSlug`, `ctx.telemetry`

- `ctx.api: { url; key }` — the SolidActions internal API base URL and key for this run. The durable operations and `SolidActionsClient` use this; you rarely need it directly.
- `ctx.mode: 'resident' | 'oneshot' | 'local'` — how the workflow is being executed: a warm resident process, a single-shot container invocation, or a local run via `solidactions dev`.
- `ctx.workflowSlug?: string` — the deployed workflow slug (equals the app's `workflows.slug`). Absent for mock/local/older deploys.
- `ctx.telemetry?: { enabled: boolean }` — whether telemetry is enabled for this run.

### Durable operations inside `run`

Inside a `run(ctx)` body, call the durable operations through the **`SolidActions.*` static API** (`SolidActions.runStep`, `SolidActions.sleep`, `SolidActions.send`, `SolidActions.recv`, `SolidActions.setEvent`, `SolidActions.startWorkflow`, `SolidActions.logger`, `SolidActions.workflowID`, …). They are automatically bound to the current run via an async-local scope established by the engine — **no setup, no globals, no passing `ctx` around.** This is the pattern every example uses; see [Steps](#steps), [Durable Primitives](#durable-primitives), and [Communication](#communication).

> `ctx` also carries minimal `step`/`sleep`/`recv`/`send` primitives (the `DurablePrimitives` shape) for advanced use, but the `SolidActions.*` API is the documented, fully-featured surface (e.g. step retries, `recv` timeouts) and is what you should use.

---

## Workspace Databases

Workspace database bindings require `@solidactions/sdk >=0.8.0`.

A project can declare a workspace database in `solidactions.yaml` and read it through `ctx.vars`, alongside plain vars and `ConnectionVar`s:

```yaml
env:
  - MYDB:
      database: 'analytics' # workspace database name
```

This surfaces as a `DatabaseVar` at `ctx.vars.MYDB`:

```typescript
interface DatabaseVar {
  readonly name: string; // the declared database name
  readonly url: string; // a dispatch-time-minted endpoint, e.g. libsql://<hostname>
  readonly token: string; // bearer token for this run — treat as a secret
  readonly readOnly: boolean; // true once the workspace's write fuse has tripped
}
```

On the wire, the private JSON payload uses `read_only`; SDK hydration exposes that field as the public `DatabaseVar.readOnly` property. Workflow code should consume the typed SDK object instead of parsing the transport string.

- Like `ConnectionVar`, the token is minted per-dispatch and scoped to the run — you never manage a long-lived credential yourself.
- **`readOnly`**: if a workspace's write budget trips (the write fuse), new tokens are minted read-only and writes fail — reads keep working. Check `ctx.vars.MYDB.readOnly` if you want to fail fast instead of surfacing the database's own rejection.
- `url`/`token`/`readOnly` are not stable across a durable sleep: on resume the entire var is rehydrated fresh from the live dispatch (current endpoint, current fuse state), not replayed from a stored snapshot. The token is redacted before any durable snapshot is written, so plaintext credentials never persist — this is automatic and needs no handling in workflow code.

### `createDatabaseClient()`

`createDatabaseClient(v: DatabaseVar)` wraps a `DatabaseVar` in a client that executes raw SQL:

```typescript
interface DatabaseClient {
  execute(sql: string, args?: unknown[]): Promise<DatabaseExecuteResult>;
}

interface DatabaseExecuteResult {
  columns: string[];
  rows: (string | number | boolean | Buffer | null)[][];
  rowsAffected?: number;
  lastInsertRowid?: string; // a string — rowids can exceed Number.MAX_SAFE_INTEGER
}
```

`execute()` is **raw SQL passthrough** — no query builder, no dialect filtering. Anything the workspace database accepts works verbatim, including full-text search and vector search. Wrap calls in `SolidActions.runStep()` for checkpointing, same as any other side effect:

```typescript
import { SolidActions, defineWorkflow, createDatabaseClient, type DatabaseVar } from '@solidactions/sdk';

export const analyticsWorkflow = defineWorkflow<{ userId: string }, { count: number }>({
  name: 'analytics-workflow',
  async run(ctx) {
    const db = createDatabaseClient(ctx.vars.MYDB as DatabaseVar);

    await SolidActions.runStep(() => db.execute('CREATE TABLE IF NOT EXISTS events (id TEXT, user_id TEXT)'), {
      name: 'ensure-table',
    });

    await SolidActions.runStep(
      () => db.execute('INSERT INTO events (id, user_id) VALUES (?, ?)', [SolidActions.randomUUID(), ctx.input.userId]),
      { name: 'insert-event' },
    );

    const result = await SolidActions.runStep(
      () => db.execute('SELECT COUNT(*) as count FROM events WHERE user_id = ?', [ctx.input.userId]),
      { name: 'count-events' },
    );

    return { count: Number(result.rows[0][0]) };
  },
});
```

With `InvokeCtxVarsAugment` generated for this project (see [Typed `ctx.vars`](#typed-ctxvars)), `ctx.vars.MYDB` is `DatabaseVar` directly — no cast needed.

### `createAnalyticalDatabaseClient()`

Analytical database ingest requires `@solidactions/sdk >=0.9.0`. A `database:` mapping may resolve to either a libSQL `DatabaseVar` or an analytical database UUID. Generated vars therefore allow both kinds; each factory gives a teaching error if the server-resolved kind is passed to the wrong one.

```typescript
import {
  SolidActions,
  defineWorkflow,
  createAnalyticalDatabaseClient,
  type AnalyticalDatabaseBinding,
} from '@solidactions/sdk';

export const ingest = defineWorkflow<{ rows: Record<string, unknown>[] }, void>({
  name: 'analytical-ingest',
  async run(ctx) {
    const db = createAnalyticalDatabaseClient(ctx.vars.WAREHOUSE as AnalyticalDatabaseBinding);
    await SolidActions.runStep(() => db.append('events', ctx.input.rows), { name: 'append-events' });
    await SolidActions.runStep(() => db.replace('daily_rollup', ctx.input.rows), { name: 'replace-rollup' });
    await SolidActions.runStep(() => db.ingestFile('events', './events.parquet'), { name: 'ingest-events-file' });
  },
});
```

With generated `InvokeCtxVarsAugment` types, the cast is unnecessary. `append` adds rows and `replace` atomically replaces the table contents. `ingestFile` streams `.parquet`, `.csv`, or `.jsonl` through staged storage without buffering the file; use `format` for an extensionless path.

The complete UTF-8 inline request body is limited by `inline_batch_max_bytes=5,242,880 bytes (5 MiB)`. Oversized calls fail locally with `inline_batch_too_large` before network I/O.

In 0.9.0, generated `database:` mappings migrate from `DatabaseVar` to the `DatabaseVar | AnalyticalDatabaseBinding` union because the project declaration does not know which database kind the server will resolve. Existing code may keep passing the binding directly to `createDatabaseClient`, whose runtime guard gives a teaching error if it receives an analytical UUID. Code that handles both kinds can narrow the union by its wire shape:

```typescript
import {
  createAnalyticalDatabaseClient,
  createDatabaseClient,
  type AnalyticalDatabaseBinding,
  type DatabaseVar,
} from '@solidactions/sdk';

function clientFor(binding: DatabaseVar | AnalyticalDatabaseBinding) {
  return typeof binding === 'string' ? createAnalyticalDatabaseClient(binding) : createDatabaseClient(binding);
}
```

The helper derives a stable `batchId` from the database, normalized table, mode, format, and canonical content digest. An identical durable-step retry safely resumes or replays the server ledger. If you supply `batchId`, derive it deterministically from workflow input—never use the current time or a fresh random UUID outside the step.

Calls wait for a durable acknowledgement (two-minute inline and 45-minute file defaults). A timeout throws `AnalyticalIngestError` with `code === 'ingest_pending'`, `batchId`, and `lastState`; it does not mean the batch failed, so retry the identical call. Structured server errors retain their code, status, and details. `insufficient_credit` is not retried. `AbortSignal` cancels local hashing, upload, API calls, and polling, but cannot roll back an already submitted batch and is not restored across durable resume.

---

## Steps

Steps are the building blocks of workflows. They wrap ordinary functions and provide checkpointing — if a workflow is interrupted, it resumes from the last completed step. The function passed to a step is **not** re-executed on resume; its recorded result is replayed.

### `SolidActions.runStep()` (preferred)

```typescript
static runStep<Return>(
  func: () => Promise<Return>,
  config?: StepConfig & { name?: string }
): Promise<Return>
```

```typescript
import { SolidActions, defineWorkflow } from '@solidactions/sdk';

export const wf = defineWorkflow<{ url: string }, void>({
  name: 'fetch-and-save',
  async run(ctx) {
    const data = await SolidActions.runStep(() => fetchFromApi(ctx.input.url), { name: 'fetchData' });
    await SolidActions.runStep(() => saveToDb(data), { name: 'saveData' });
  },
});
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
const result = await SolidActions.runStep(() => callUnreliableApi(), {
  name: 'callApi',
  retriesAllowed: true,
  maxAttempts: 5,
  intervalSeconds: 2,
  backoffRate: 3,
});
```

### Determinism Rules

The `run` function (the code **outside** of steps) **must be deterministic**: given the same inputs, it must invoke the same steps in the same order. All non-deterministic operations must be inside steps.

**Do NOT do this directly in `run` (outside a step):**

- HTTP requests (`fetch`, API calls)
- File system access
- Random number generation (use `SolidActions.randomUUID()` or wrap in a step)
- Get current time (use `SolidActions.now()` or wrap in a step)
- Access databases

**Safe directly in `run`:**

- Loops, branches, conditionals (deterministic logic)
- Reading `ctx.input` / `ctx.vars`
- Calling `SolidActions.runStep()`
- Calling `SolidActions.sleep()`, `SolidActions.send()`, `SolidActions.recv()`
- Calling `SolidActions.setEvent()`, `SolidActions.getEvent()`
- Calling `SolidActions.now()`, `SolidActions.randomUUID()`
- Calling `SolidActions.startWorkflow()`

### Parallel Step Execution

Use `Promise.allSettled()` to run steps in parallel. Steps must be **started in a deterministic order** (the array literal order is deterministic):

```typescript
const results = await Promise.allSettled([
  SolidActions.runStep(() => fetchUserProfile(userId), { name: 'profile' }),
  SolidActions.runStep(() => fetchUserOrders(userId), { name: 'orders' }),
  SolidActions.runStep(() => fetchUserPrefs(userId), { name: 'prefs' }),
]);
```

**Do NOT use `Promise.all()`** — when any promise rejects, `Promise.all` immediately fails, leaving other promises unresolved. If one of those later throws, it crashes the Node.js process. Always use `Promise.allSettled()`.

**Do NOT nest async functions in `Promise.allSettled()`** — the execution order of steps inside nested async functions is non-deterministic. For sequences of operations in parallel, use child workflows via `SolidActions.startWorkflow()`.

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
export const reminder = defineWorkflow<{ userId: string }, void>({
  name: 'reminder',
  async run(ctx) {
    await SolidActions.runStep(() => sendInitialEmail(ctx.input.userId), { name: 'sendEmail' });
    await SolidActions.sleep(86400000); // Sleep 24 hours (durable)
    await SolidActions.runStep(() => sendFollowUp(ctx.input.userId), { name: 'followUp' });
  },
});
```

### `SolidActions.now()`

Returns the current time as a UNIX epoch timestamp in milliseconds. Deterministic — on recovery, returns the same value recorded during the original execution.

```typescript
static async now(): Promise<number>
```

### `SolidActions.randomUUID()`

Generates a deterministic UUID. On recovery, returns the same UUID generated during the original execution.

```typescript
static async randomUUID(): Promise<string>
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
- `recv()` can only be called from a workflow `run` function (not from steps).
- Messages without a topic are separate from messages with topics.
- `recv()` returns `null` if the timeout expires.
- All messages are persisted — if `send` completes, the receiver is guaranteed to get it.

```typescript
export const approval = defineWorkflow<{ requestId: string }, string>({
  name: 'approval',
  async run(ctx) {
    await SolidActions.runStep(() => sendApprovalRequest(ctx.input.requestId), { name: 'requestApproval' });

    // Wait up to 24 hours for approval (the container suspends and resumes on message arrival)
    const decision = await SolidActions.recv<string>('approval', 86400);
    if (decision === 'approved') {
      await SolidActions.runStep(() => executeRequest(ctx.input.requestId), { name: 'execute' });
      return 'completed';
    }
    return 'rejected';
  },
});

// External caller sends approval (by workflow ID):
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

- `setEvent()` can only be called from a workflow `run` function (not from steps).
- `getEvent()` can be called from anywhere.
- Events are persisted and the latest value is always retrievable.
- `getEvent()` waits for the event to be published, returning `null` on timeout.

```typescript
export const checkout = defineWorkflow<{ orderId: string }, void>({
  name: 'checkout',
  async run(ctx) {
    const paymentUrl = await SolidActions.runStep(() => createPaymentSession(ctx.input.orderId), {
      name: 'createPayment',
    });
    await SolidActions.setEvent('paymentUrl', paymentUrl); // publish for the caller

    const confirmation = await SolidActions.recv<string>('paymentComplete', 3600);
    if (confirmation) {
      await SolidActions.runStep(() => fulfillOrder(ctx.input.orderId), { name: 'fulfill' });
    }
  },
});

// Caller reads the published value:
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
export const streaming = defineWorkflow<void, void>({
  name: 'streaming',
  async run() {
    for (let i = 0; i < 10; i++) {
      const result = await SolidActions.runStep(() => processChunk(i), { name: `chunk-${i}` });
      await SolidActions.writeStream('progress', { step: i, result });
    }
    await SolidActions.closeStream('progress');
  },
});

// Reader:
for await (const value of SolidActions.readStream(workflowID, 'progress')) {
  console.log(`Progress: ${JSON.stringify(value)}`);
}
```

### `SolidActions.respond()`

Sends an early response body to the external caller. Used in webhook wait-mode workflows to return a response before the workflow completes.

```typescript
static async respond(
  body: unknown,
  options?: { status?: number; headers?: Record<string, string> },
): Promise<void>
```

- Can only be called from a workflow `run` function (not from steps).
- The body is sent back to the HTTP caller that triggered the webhook.
- Must be called while the webhook request is still waiting (within the webhook timeout).
- `options.status` — HTTP status code to return (default: `200`)
- `options.headers` — Additional response headers (merged with `Content-Type: application/json`)

```typescript
export const webhookWf = defineWorkflow<{ query: string }, void>({
  name: 'webhook-wf',
  async run(ctx) {
    const quickResult = await SolidActions.runStep(() => fastLookup(ctx.input.query), { name: 'lookup' });
    await SolidActions.respond({ status: 'ok', data: quickResult }); // early response

    await SolidActions.runStep(() => heavyProcessing(ctx.input.query), { name: 'process' });
  },
});
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

- Must be called from within a workflow `run` function.
- Returns URLs that send signals to the current workflow via the platform's signal API.
- Every returned URL includes the current run's per-run credential. Treat these URLs as secrets: do not log them or forward them beyond the intended recipient.

```typescript
export const approvalUrls = defineWorkflow<{ id: string }, void>({
  name: 'approval-urls',
  async run() {
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
  },
});
```

---

## Child Workflows

Use `SolidActions.startWorkflow()` to start another workflow descriptor in the background and get a `WorkflowHandle`:

```typescript
static startWorkflow<Args extends unknown[], Return>(
  target: WorkflowDescriptor<...> | ((...args: Args) => Promise<Return>),
  params?: StartWorkflowParams
): (...args: Args) => Promise<WorkflowHandle<Return>>
```

`StartWorkflowParams`:

- `workflowID?: string` — Custom workflow ID (acts as an idempotency key)
- `timeoutMS?: number` — Timeout in milliseconds

Pass the **descriptor returned by `defineWorkflow`** as the target:

```typescript
import { SolidActions, defineWorkflow } from '@solidactions/sdk';
import { childTask } from './child-task.js'; // a defineWorkflow descriptor

export const parentChild = defineWorkflow<{ value: number }, unknown>({
  name: 'parent-child',
  async run(ctx) {
    const prepared = await SolidActions.runStep(() => prepare(ctx.input.value), { name: 'prepare' });

    // Start the child and await its result
    const childHandle = await SolidActions.startWorkflow(childTask)(prepared.childInput);
    const childResult = await childHandle.getResult();

    return await SolidActions.runStep(() => processResult(childResult), { name: 'process-result' });
  },
});
```

### Workflow IDs and Idempotency

Every workflow execution gets a unique ID (UUID by default). A custom workflow ID acts as an **idempotency key**: starting a workflow with the same ID multiple times executes it only once.

```typescript
const handle = await SolidActions.startWorkflow(chargeWorkflow, {
  workflowID: `charge-${orderId}`, // idempotent: charges only once
})(customerId, amount);
```

### Workflow Timeouts

Set a timeout via `startWorkflow()`. When the timeout expires, the workflow and all its children are cancelled. Timeouts are **start-to-completion** and **durable** (persist across restarts).

```typescript
const handle = await SolidActions.startWorkflow(myWorkflow, { timeoutMS: 60000 })('input');
```

### Retrieving a Workflow by ID

```typescript
static retrieveWorkflow<T = unknown>(workflowID: string): WorkflowHandle<Awaited<T>>
```

```typescript
const handle = SolidActions.retrieveWorkflow<string>('my-workflow-id');
const status = await handle.getStatus();
const result = await handle.getResult();
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

- `handle.workflowID` — the unique ID of the workflow execution.
- `handle.getResult()` — waits for the workflow to complete, then returns its result. Throws if the workflow errors.
- `handle.getStatus()` — returns the current `WorkflowStatus`.
- `handle.getWorkflowInputs()` — returns the deserialized arguments passed to the workflow.

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

## Static Context Accessors

Inside a workflow or step, these static accessors report the current execution context. (`ctx.input` and `ctx.vars` come from the [context object](#the-context-object-ctx); the values below are read from `SolidActions.*`.)

```typescript
SolidActions.workflowID: string | undefined    // Current workflow ID
SolidActions.runID: string | undefined          // Current run ID
SolidActions.stepID: number | undefined          // Current step ID within the workflow
SolidActions.stepStatus: StepStatus | undefined  // Current step retry info
SolidActions.logger: DLogger                     // Logger instance
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
export const wf = defineWorkflow<void, void>({
  name: 'logs-its-id',
  async run() {
    SolidActions.logger.info(`Workflow ${SolidActions.workflowID} started`);
    await SolidActions.runStep(() => doWork(), { name: 'work' });
  },
});
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
client.retrieveWorkflow<T>(workflowID: string): WorkflowHandle<Awaited<T>>
client.send<T>(destinationID: string, message: T, topic?: string, idempotencyKey?: string): Promise<void>
client.getEvent<T>(workflowID: string, key: string, timeoutSeconds?: number): Promise<T | null>
client.cancelWorkflow(workflowID: string): Promise<void>
client.resumeWorkflow(workflowID: string): Promise<void>
client.forkWorkflow(workflowID: string, startStep: number, options?: { newWorkflowID?: string; applicationVersion?: string; timeoutMS?: number }): Promise<string>
client.getWorkflow(workflowID: string): Promise<WorkflowStatus | undefined>
client.listWorkflows(input: GetWorkflowsInput): Promise<WorkflowStatus[]>
client.listWorkflowSteps(workflowID: string): Promise<StepInfo[] | undefined>
client.readStream<T>(workflowID: string, key: string): AsyncGenerator<T, void, unknown>
client.destroy(): Promise<void>
```

```typescript
import { SolidActionsClient } from '@solidactions/sdk';

const client = SolidActionsClient.create({
  httpConfig: { apiUrl: 'https://app.solidactions.com/api/internal', apiKey: 'sa_key_...' },
});

const status = await client.getWorkflow('wf-123');
console.log(status?.status); // 'SUCCESS'

await client.send('wf-456', 'approved', 'approval');

for await (const chunk of client.readStream('wf-789', 'output')) {
  console.log(chunk);
}

await client.destroy();
```

---

## Configuration

`SolidActionsConfig` is used by `SolidActions.setConfig()` for **standalone / testing** setups (deployed workflows are configured by the platform — you do not call `setConfig`/`launch` in workflow code).

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

interface SerializationRecipe<T, S> {
  name: string;
  isApplicable: (v: unknown) => v is T;
  serialize: (v: T) => S;
  deserialize: (s: S) => T;
}
```

```typescript
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
SolidActions.logger.info('Processing started');
SolidActions.logger.warn('Rate limit approaching');
SolidActions.logger.error(`Error: ${(error as Error).message}`);
SolidActions.logger.debug('Step details', { stepId: SolidActions.stepID });
```

---

## Local Development

Run workflows locally without deploying using the CLI's in-memory mock server. This is ideal for fast iteration on workflow logic.

### Using the CLI (recommended)

```bash
npm install -g @solidactions/cli

# Run a workflow file locally — no deploy, no auth, no backend needed
solidactions dev src/my-workflow.ts -i '{"key": "value"}'

# Pull a deployed environment's variables into ctx.vars for the local run
solidactions dev src/my-workflow.ts -i '{"key": "value"}' --env dev
```

The `dev` command loads your module, builds a `ctx` (with `ctx.mode === 'local'`), runs the exported descriptor, and mocks durable primitives in-process. It populates `ctx.vars` explicitly (from `solidactions.yaml` and, with `--env`, the platform) — it never leaks `process.env` into `ctx.vars`. All step execution works normally; only platform features like durable sleep wakeups and cross-process messaging are no-ops.

### What works locally vs what doesn't

| Works                          | No-op locally                   |
| ------------------------------ | ------------------------------- |
| Sequential & parallel steps    | Durable sleep scheduler wakeups |
| Child workflows                | Cross-process messaging         |
| Events (`setEvent`/`getEvent`) | Webhook `respond()`             |
| Streams                        | Persistent recovery after crash |
| Retries with backoff           |                                 |

## Testing

For custom test setups, import `createMockServer` from `@solidactions/sdk/testing`. In tests you configure the SDK manually with `setConfig` + `launch` (the platform does this for you in production):

```typescript
import { createMockServer, MockHttpServer } from '@solidactions/sdk/testing';
import { SolidActions } from '@solidactions/sdk';

let server: MockHttpServer;

beforeAll(async () => {
  server = await createMockServer();
  SolidActions.setConfig({
    name: 'test-app',
    api: { url: server.baseUrl, key: 'test-key' },
  });
  await SolidActions.launch();
});

afterAll(async () => {
  await SolidActions.shutdown();
  await server.stop();
});
```

The mock server implements the full SolidActions HTTP API in memory — workflows, steps, messages, events, and streams all work.

For test isolation of event receivers:

```typescript
beforeEach(async () => {
  await SolidActions.deactivateEventReceivers();
});

afterEach(async () => {
  await SolidActions.initEventReceivers();
});
```

---

## Error Classes

All SDK errors extend `SolidActionsError`. Errors are exported under the `Error` namespace:

```typescript
import { Error } from '@solidactions/sdk';

// Use as Error.SolidActionsError, Error.SolidActionsWorkflowConflictError, etc.
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
| `WorkflowAlreadyRegisteredError`               | `defineWorkflow` called twice with the same name              |
| `WorkflowNotRegisteredError`                   | A workflow name was dispatched but never registered           |
| `SolidActionsHttpError`                        | HTTP communication error (base class)                         |
| `SolidActionsUnauthorizedError`                | 401 response                                                  |
| `SolidActionsForbiddenError`                   | 403 response                                                  |
| `SolidActionsNotFoundError`                    | 404 response                                                  |
| `SolidActionsRateLimitedError`                 | 429 response (has `.retryAfterSeconds?: number`)              |
| `SolidActionsServerError`                      | 5xx response                                                  |
| `SolidActionsNetworkError`                     | Network connectivity failure                                  |

---

## Legacy and Migration

The `ctx` contract (this document's primary API) replaced an earlier static-entry model in SDK v0.5.0 ("ctx cutover") and v0.6.0. The legacy entry points still exist for backward compatibility but are not recommended for new code.

| Legacy (pre-`ctx`)                                                                   | Current                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `SolidActions.registerWorkflow(fn)`                                                  | `defineWorkflow({ name, run })` (`registerWorkflow` is `@deprecated`)     |
| `SolidActions.run(fn)` as the entry point                                            | `export const wf = defineWorkflow({ … })` — no entry call                 |
| `SolidActions.getInput()` / `getInputAsync()`                                        | `ctx.input`                                                               |
| Tenant vars read from `process.env`                                                  | `ctx.vars` (single source of truth; `process.env` no longer carries them) |
| `@SolidActions.workflow()` / `@SolidActions.step()` decorators, `ConfiguredInstance` | `defineWorkflow` with plain functions                                     |

> **Deployed modules must not self-invoke.** A top-level `SolidActions.run(...)`
> in a deployed workflow module used to cause the platform launcher to execute
> the workflow twice concurrently (second execution saw empty `ctx.vars`) —
> solidactions-app#414. Current SDKs detect this and run the workflow once, with
> a deprecation warning in the run logs. Remove the top-level call and export
> the `defineWorkflow` descriptor instead.

`SolidActions.run()` itself still works — internally it now adapts the process environment into a `ctx` and routes through the same `invoke()` engine — but exporting a `defineWorkflow` descriptor is the supported pattern.

The class-based API (`@SolidActions.workflow()`, `@SolidActions.step()`, `@SolidActions.className()`, and `ConfiguredInstance`) remains available for advanced cases needing instance-level configuration, but plain functions wrapped by `defineWorkflow` are preferred.

---

## Rules for AI Consumers

### Do

- Import everything from `@solidactions/sdk`
- Define workflows with `defineWorkflow({ name, run })` and **always pass an explicit `name`**
- `export` the workflow descriptor — do not add an entry-point call
- Read input from `ctx.input` and tenant variables from `ctx.vars`
- Treat `ctx.vars.X` as `string | ConnectionVar`; for OAuth, call through the `ConnectionVar`'s `proxyUrl` with `proxyToken`
- Use `SolidActions.runStep()` for all non-deterministic operations
- Call durable operations (`runStep`, `sleep`, `send`, `recv`, `setEvent`, `startWorkflow`, …) via `SolidActions.*` inside `run`
- Use `Promise.allSettled()` for parallel step execution
- Keep the `run` function deterministic outside of steps
- Use `SolidActions.now()` instead of `Date.now()`, and `SolidActions.randomUUID()` instead of `crypto.randomUUID()`
- Use `SolidActions.sleep()` instead of `setTimeout` for delays
- Fully type `defineWorkflow<Input, Output>` and all step signatures
- Await all promises

### Do Not

- Do not use `SolidActions.getInput()` — read `ctx.input` (legacy: `getInput`/`getInputAsync`)
- Do not read tenant variables from `process.env` — use `ctx.vars`
- Do not rely on `SolidActions.run()` / `registerWorkflow()` as the entry point — export a `defineWorkflow` descriptor
- Do not use an anonymous arrow `run` without a `name` — `defineWorkflow` will throw
- Do not call context methods (`send`, `recv`, `setEvent`, `getEvent`, `sleep`, `startWorkflow`) from inside a step
- Do not call `SolidActions.setEvent` or `SolidActions.recv` from outside a workflow `run` function
- Do not use `Promise.all()` — use `Promise.allSettled()`
- Do not perform non-deterministic operations directly in `run` (outside a step)
- Do not use `systemDatabaseUrl` — the SDK uses HTTP API configuration
- Do not use the deprecated `composio` connection broker — use the `pica` proxy contract
- Do not reference `WorkflowQueue`, `Debouncer`, `registerScheduled`, or `@SolidActions.scheduled()` — these features do not exist
- Do not import from `@dbos-inc/dbos-sdk` — use `@solidactions/sdk`
- Do not reference `Toolbox`, `koaContext`, `getApi`, `postApi`, or `SolidActions Transact`
- Do not create or update global variables from workflows or steps
