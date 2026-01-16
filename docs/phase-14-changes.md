# Phase 14: SDK Feature Simplification

**Date:** 2026-01-12

This document summarizes the changes made in Phase 14 to simplify the SolidSteps DBOS SDK by removing features not needed for ephemeral container architecture.

## Rationale

In SolidSteps, containers are ephemeral - they start, execute a workflow (or portion of one), and exit. Features like long-running schedulers, in-process queues, and debouncing don't make sense in this model:

- **Scheduling**: Laravel scheduler triggers webhooks at scheduled times
- **Queues**: Laravel/runner handle queue management externally
- **Debouncing**: Should be handled at the API layer before workflow trigger

## Files Deleted

| File                         | Purpose                                 |
| ---------------------------- | --------------------------------------- |
| `src/scheduler/scheduler.ts` | Cron-based workflow scheduling          |
| `src/scheduler/crontab.ts`   | Crontab parsing utilities               |
| `src/debouncer.ts`           | Workflow call debouncing                |
| `src/wfqueue.ts`             | Workflow queue with concurrency control |

## Key SDK Changes

### `src/dbos.ts`

**Removed:**

- `registerScheduled()` method - registered scheduled workflows
- `@scheduled` decorator - decorator for scheduled workflows
- `withWorkflowQueue()` method - execute workflows in queue context
- `listQueuedWorkflows()` method - list queued workflows
- Scheduler and queue imports

**Changed:**

- `initEventReceivers()` no longer takes `listenQueues` parameter

### `src/dbos-executor.ts`

**Removed:**

- `ScheduledReceiver` instantiation in constructor
- `wfQueueRunner` references and dispatch loop
- `getQueueByName()` method
- `listQueuedWorkflows()` method
- Queue priority validation in `executeWorkflow()`
- `#wfqEnded` promise field
- `createInternalQueue()` static method
- `createDebouncerWorkflow()` static method
- `DBOS_QUEUE_MIN_PRIORITY` and `DBOS_QUEUE_MAX_PRIORITY` constants
- `listenQueues` from `DBOSConfig` interface

**Changed:**

- Simplified workflow recovery - no longer re-enqueues to queue
- `initEventReceivers()` simplified to only call lifecycle listeners
- `deactivateEventReceivers()` simplified - no queue runner to stop

### `src/index.ts`

**Removed exports:**

- `SchedulerMode` - scheduling mode enum
- `SchedulerConfig` - scheduler configuration
- `WorkflowQueue` - queue class
- `Debouncer` - debouncer class
- `DebouncerClient` - client-side debouncer
- `GetQueuedWorkflowsInput` alias

### `src/system_database.ts`

**Removed from `SystemDatabase` interface:**

- `clearQueueAssignment()` - clear workflow queue assignment
- `getDeduplicatedWorkflow()` - get deduplicated workflow ID
- `getQueuePartitions()` - get queue partition keys
- `findAndMarkStartableWorkflows()` - find and mark startable queued workflows

**Removed:**

- `WorkflowQueue` import

### `src/http_system_database.ts`

**Removed methods:**

- `clearQueueAssignment()` - HTTP call to clear queue assignment
- `getDeduplicatedWorkflow()` - HTTP call to get deduplicated workflow
- `getQueuePartitions()` - HTTP call to get queue partitions
- `findAndMarkStartableWorkflows()` - HTTP call to find startable workflows

**Removed:**

- `WorkflowQueue` import
- Entire "Queue Methods" section

### `src/client.ts`

**Removed:**

- `ClientEnqueueOptions` interface - options for enqueue operation
- `enqueue()` method - enqueue workflow for later execution

### `src/adminserver.ts`

**Removed:**

- `WorkflowQueuesMetadataUrl` constant
- `QueueMetadataResponse` type
- `registerQueueMetadataEndpoint()` - GET `/dbos-workflow-queues-metadata`
- `registerListQueuedWorkflowsEndpoint()` - POST `/queues`
- `wfQueueRunner` import

### `src/conductor/conductor.ts`

**Removed:**

- `LIST_QUEUED_WORKFLOWS` message handler case

## Migration Notes

### For Tenant Developers

If your workflows used any of these features, here's how to migrate:

| Removed Feature            | Migration Path                                            |
| -------------------------- | --------------------------------------------------------- |
| `@DBOS.scheduled()`        | Use Laravel scheduler to trigger webhook at desired times |
| `WorkflowQueue`            | Concurrency controlled by runner worker count             |
| `DBOS.withWorkflowQueue()` | Remove - not needed                                       |
| `Debouncer`                | Implement debouncing in your webhook handler              |
| `DBOSClient.enqueue()`     | Use `POST /api/webhook/{token}` to trigger workflows      |

### For Platform Developers

The following Laravel-side endpoints are no longer called by the SDK:

- `DELETE /workflows/{id}/queue-assignment`
- `GET /queues/{name}/deduplicated/{deduplicationID}`
- `GET /queues/{name}/partitions`
- `POST /queues/{name}/start-workflows`

These can be removed from the Laravel API if not used elsewhere.

## Verification

- [x] SDK compiles without errors
- [x] SDK synced to `examples/dbos-test/sdk/`
- [ ] Example workflows tested (pending)
- [ ] SDK unit tests pass (pending)

## Related Documentation

- [SDK Differences](../../docs/dbos-sdk-differences.md) - Updated with "Removed Features" section
