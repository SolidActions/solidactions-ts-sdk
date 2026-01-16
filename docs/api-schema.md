# DBOS HTTP API Schema

This document defines the HTTP API that must be implemented by the backend (Laravel) to support the DBOS TypeScript SDK.

## Overview

The SDK communicates with the backend exclusively via HTTP API calls. All workflow state, operations, messages, events, and streams are managed through these endpoints.

**Base URL**: Configured via `DBOS_API_URL` environment variable or `api.url` in config file.

## Authentication

All requests include a Bearer token in the Authorization header:

```
Authorization: Bearer <api_key>
```

The API key is configured via `DBOS_API_KEY` environment variable or `api.key` in config file.

## Common Headers

**Request Headers:**

```
Content-Type: application/json
Accept: application/json
Authorization: Bearer <api_key>
```

**Response Headers:**

```
Content-Type: application/json
```

## Error Responses

All error responses follow this format:

```json
{
  "message": "Human-readable error message",
  "type": "error_type", // Optional: specific error type
  "workflowID": "uuid", // Optional: for workflow-specific errors
  "retryAfter": 60 // Optional: seconds to wait (for 429)
}
```

### HTTP Status Code Mapping

| Status | SDK Exception                  | When to Return                                        |
| ------ | ------------------------------ | ----------------------------------------------------- |
| 400    | `DBOSDataValidationError`      | Invalid request body or parameters                    |
| 401    | `DBOSUnauthorizedError`        | Invalid or missing API key                            |
| 403    | `DBOSForbiddenError`           | Valid API key but insufficient permissions            |
| 404    | `DBOSNotFoundError`            | Resource not found (general)                          |
| 404    | `DBOSNonExistentWorkflowError` | Workflow not found (set `type: "workflow_not_found"`) |
| 409    | `DBOSWorkflowConflictError`    | Workflow UUID conflict                                |
| 429    | `DBOSRateLimitedError`         | Rate limit exceeded (include `retryAfter`)            |
| 5xx    | `DBOSServerError`              | Server errors (SDK will retry with backoff)           |

---

## Endpoints

### Health Check

#### GET /health

Verify API connectivity.

**Response 200:**

```json
{
  "status": "ok"
}
```

---

## Workflow Endpoints

### Create Workflow

#### POST /workflows

Initialize a new workflow status record.

**Request Body:**

```json
{
  "workflowUUID": "string", // Required: Unique workflow ID
  "status": "string", // Required: Initial status (typically "PENDING" or "ENQUEUED")
  "workflowName": "string", // Required: Function name
  "workflowClassName": "string", // Required: Class name (empty string if none)
  "workflowConfigName": "string", // Required: Config name (empty string if none)
  "queueName": "string | null", // Optional: Queue name if enqueued
  "authenticatedUser": "string", // Required: User ID (empty string if none)
  "assumedRole": "string", // Required: Role (empty string if none)
  "authenticatedRoles": ["string"], // Required: Array of roles
  "request": {}, // Required: Request context object
  "executorId": "string", // Required: Executor ID
  "applicationVersion": "string", // Optional: App version
  "applicationID": "string", // Required: Application ID
  "input": "string | null", // Required: Serialized JSON input
  "output": null, // Required: null on creation
  "error": null, // Required: null on creation
  "createdAt": 1234567890, // Required: Unix timestamp ms
  "timeoutMS": 30000, // Optional: Workflow timeout
  "deadlineEpochMS": 1234567890, // Optional: Absolute deadline
  "deduplicationID": "string", // Optional: For queue deduplication
  "priority": 0, // Required: Queue priority (0 = highest)
  "queuePartitionKey": "string", // Optional: Partition key
  "forkedFrom": "string", // Optional: Parent workflow ID
  "ownerXid": "string | null", // Required: Transaction ID
  "options": {
    "isRecoveryRequest": false, // Optional
    "isDequeuedRequest": false, // Optional
    "maxRetries": 100 // Optional
  }
}
```

**Response 200/201:**

```json
{
  "status": "PENDING", // Current status after creation
  "shouldExecuteOnThisExecutor": true, // Whether this executor should run it
  "deadlineEpochMS": 1234567890 // Optional: Calculated deadline
}
```

**Atomicity**: This endpoint must be atomic. If a workflow with the same UUID exists:

- Return `shouldExecuteOnThisExecutor: false` if another executor is handling it
- Return 409 if there's a true conflict

---

### Get Workflow Status

#### GET /workflows/{workflowID}

Retrieve workflow status.

**Path Parameters:**

- `workflowID` (string, URL-encoded): Workflow UUID

**Query Parameters:**

- `callerID` (string, optional): Calling workflow's ID
- `callerFN` (number, optional): Calling workflow's function ID

**Response 200:**

```json
{
  "workflowUUID": "string",
  "status": "PENDING | SUCCESS | ERROR | CANCELLED | ENQUEUED | MAX_RECOVERY_ATTEMPTS_EXCEEDED",
  "workflowName": "string",
  "workflowClassName": "string",
  "workflowConfigName": "string",
  "queueName": "string | null",
  "authenticatedUser": "string",
  "assumedRole": "string",
  "authenticatedRoles": ["string"],
  "request": {},
  "executorId": "string",
  "applicationVersion": "string",
  "applicationID": "string",
  "input": "string | null", // Serialized JSON
  "output": "string | null", // Serialized JSON
  "error": "string | null", // Serialized error
  "createdAt": 1234567890,
  "updatedAt": 1234567890,
  "recoveryAttempts": 0,
  "timeoutMS": 30000,
  "deadlineEpochMS": 1234567890,
  "deduplicationID": "string",
  "priority": 0,
  "queuePartitionKey": "string",
  "forkedFrom": "string"
}
```

**Response 404** (workflow not found):

```json
{
  "message": "Workflow not found",
  "type": "workflow_not_found"
}
```

---

### List Workflows

#### GET /workflows

List workflows with optional filters.

**Query Parameters:**

- `workflowName` (string): Filter by workflow name
- `authenticatedUser` (string): Filter by user
- `startTime` (string): RFC 3339 timestamp, workflows created after
- `endTime` (string): RFC 3339 timestamp, workflows created before
- `status` (string): Filter by status
- `applicationVersion` (string): Filter by app version
- `workflowID` (string): Filter by workflow ID (exact or prefix match)
- `limit` (number): Max results (default: 100)
- `offset` (number): Pagination offset
- `sortAscending` (boolean): Sort order (default: false = descending)

**Response 200:**

```json
[
  {
    "workflowUUID": "string",
    "status": "string"
    // ... full WorkflowStatusInternal object
  }
]
```

---

### Record Workflow Output

#### PUT /workflows/{workflowID}/output

Record successful workflow completion.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Request Body:**

```json
{
  "output": "string", // Serialized JSON output
  "status": "SUCCESS" // New status
}
```

**Response 200:**

```json
{}
```

---

### Record Workflow Error

#### PUT /workflows/{workflowID}/error

Record workflow failure.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Request Body:**

```json
{
  "error": "string", // Serialized error
  "status": "ERROR" // New status
}
```

**Response 200:**

```json
{}
```

---

### Get Workflow Result (Polling)

#### GET /workflows/{workflowID}/result

Get workflow result for polling. SDK polls this endpoint until workflow completes.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Query Parameters:**

- `callerID` (string, optional): Calling workflow's ID
- `timerFuncID` (number, optional): Timer function ID

**Response 200** (workflow complete):

```json
{
  "output": "string | null", // Serialized output
  "error": "string | null", // Serialized error
  "cancelled": false
}
```

**Response 200** (workflow still pending):

```json
null
```

**Polling**: SDK polls every 1000ms. Consider implementing long-polling or returning immediately if result is ready.

---

### Get Pending Workflows

#### GET /workflows/pending

Get workflows that need recovery.

**Query Parameters:**

- `executorId` (string, required): Executor ID
- `appVersion` (string, required): Application version

**Response 200:**

```json
[
  {
    "workflowUUID": "string",
    "queueName": "string | null"
  }
]
```

---

### Set Workflow Status

#### PUT /workflows/{workflowID}/status

Update workflow status.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Request Body:**

```json
{
  "status": "PENDING | SUCCESS | ERROR | CANCELLED | ENQUEUED | MAX_RECOVERY_ATTEMPTS_EXCEEDED",
  "resetRecoveryAttempts": false
}
```

**Response 200:**

```json
{}
```

---

### Cancel Workflow

#### POST /workflows/{workflowID}/cancel

Cancel a running workflow.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Request Body:**

```json
{}
```

**Response 200:**

```json
{}
```

**Side Effects**: Must update workflow status to "CANCELLED" and notify any waiting operations.

---

### Resume Workflow

#### POST /workflows/{workflowID}/resume

Resume a cancelled workflow.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Request Body:**

```json
{}
```

**Response 200:**

```json
{}
```

---

### Fork Workflow

#### POST /workflows/{workflowID}/fork

Create a new workflow from an existing one, starting at a specific step.

**Path Parameters:**

- `workflowID` (string): Source workflow UUID

**Request Body:**

```json
{
  "startStep": 0, // Step number to start from
  "newWorkflowID": "string", // Optional: New workflow ID
  "applicationVersion": "string", // Optional: App version
  "timeoutMS": 30000 // Optional: New timeout
}
```

**Response 200:**

```json
{
  "newWorkflowID": "string"
}
```

---

### Check If Cancelled

#### GET /workflows/{workflowID}/cancelled

Check if workflow has been cancelled.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Response 200:**

```json
{
  "cancelled": true | false
}
```

---

## Operation Endpoints

Operations are individual steps within a workflow.

### Get Operation Result

#### GET /workflows/{workflowID}/operations/{functionID}

Get a specific operation's result.

**Path Parameters:**

- `workflowID` (string): Workflow UUID
- `functionID` (number): Function/step ID

**Response 200** (operation exists):

```json
{
  "output": "string | null", // Serialized output
  "error": "string | null", // Serialized error
  "cancelled": false,
  "childWorkflowID": "string | null",
  "functionName": "string"
}
```

**Response 200** (operation not recorded yet):

```json
null
```

---

### Get All Operation Results

#### GET /workflows/{workflowID}/operations

Get all operations for a workflow.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Response 200:**

```json
[
  {
    "workflow_uuid": "string",
    "function_id": 0,
    "output": "string",
    "error": "string",
    "child_workflow_id": "string",
    "function_name": "string",
    "started_at_epoch_ms": 1234567890,
    "completed_at_epoch_ms": 1234567890
  }
]
```

---

### Record Operation Result

#### POST /workflows/{workflowID}/operations

Record an operation's completion.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Request Body:**

```json
{
  "functionID": 0, // Required: Step number
  "functionName": "string", // Required: Function name
  "checkConflict": true, // Required: Check for existing record
  "startTimeEpochMs": 1234567890, // Required: When operation started
  "endTimeEpochMs": 1234567890, // Required: When operation ended
  "output": "string | null", // Optional: Serialized output
  "error": "string | null", // Optional: Serialized error
  "childWorkflowID": "string | null" // Optional: If operation started a child workflow
}
```

**Response 200:**

```json
{}
```

**Atomicity**: If `checkConflict` is true and a record exists, return 409.

---

## Queue Endpoints

### Clear Queue Assignment

#### DELETE /workflows/{workflowID}/queue-assignment

Remove a workflow from its queue assignment.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Response 200:**

```json
{
  "cleared": true
}
```

---

### Get Deduplicated Workflow

#### GET /queues/{queueName}/deduplicated/{deduplicationID}

Find workflow by deduplication ID.

**Path Parameters:**

- `queueName` (string): Queue name
- `deduplicationID` (string): Deduplication ID

**Response 200:**

```json
{
  "workflowID": "string | null" // null if no match
}
```

---

### Get Queue Partitions

#### GET /queues/{queueName}/partitions

Get all partition keys for a queue.

**Path Parameters:**

- `queueName` (string): Queue name

**Response 200:**

```json
{
  "partitions": ["string"]
}
```

---

### Find and Mark Startable Workflows

#### POST /queues/{queueName}/start-workflows

Find workflows ready to start and mark them as starting.

**Path Parameters:**

- `queueName` (string): Queue name

**Request Body:**

```json
{
  "executorID": "string", // Required
  "appVersion": "string", // Required
  "queuePartitionKey": "string | null", // Optional
  "concurrency": 10, // Required: Max concurrent workflows
  "rateLimit": {
    // Optional: Rate limiting config
    "limitPerPeriod": 100,
    "periodSec": 60
  }
}
```

**Response 200:**

```json
{
  "workflowIDs": ["string"] // Workflows that should be started
}
```

**Atomicity**: This operation MUST be atomic (use transactions). It should:

1. Find eligible workflows (ENQUEUED status, respecting concurrency/rate limits)
2. Update their status to PENDING
3. Return their IDs

---

## Messaging Endpoints

### Send Message

#### POST /workflows/{destinationID}/messages

Send a message to a workflow.

**Path Parameters:**

- `destinationID` (string): Destination workflow UUID

**Request Body:**

```json
{
  "senderWorkflowID": "string", // Required: Sender's workflow ID
  "functionID": 0, // Required: Sender's function ID
  "message": "string | null", // Required: Message content (serialized)
  "topic": "string" // Optional: Message topic
}
```

**Response 200:**

```json
{}
```

**Side Effects**: Must wake up any `recv` polling for this destination+topic.

---

### Receive Message (Polling)

#### GET /workflows/{workflowID}/messages

Check for messages. SDK polls this endpoint.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Query Parameters:**

- `topic` (string, optional): Filter by topic
- `functionID` (number, required): Receiver's function ID
- `timeoutFunctionID` (number, required): Timeout function ID

**Response 200** (message available):

```json
{
  "message": "string | null",
  "found": true
}
```

**Response 200** (no message yet):

```json
{
  "message": null,
  "found": false
}
```

**Polling**: SDK polls every 1000ms with timeout. Consider long-polling.

---

### Durable Sleep

#### POST /workflows/{workflowID}/sleep

Record a durable sleep operation.

**Path Parameters:**

- `workflowID` (string): Workflow UUID

**Request Body:**

```json
{
  "functionID": 0, // Required: Function ID
  "duration": 5000, // Required: Sleep duration ms
  "wakeupTime": 1234567890 // Required: Wakeup timestamp ms
}
```

**Response 200:**

```json
{}
```

---

## Event Endpoints

### Set Event

#### PUT /workflows/{workflowID}/events/{key}

Set an event value.

**Path Parameters:**

- `workflowID` (string): Workflow UUID
- `key` (string): Event key

**Request Body:**

```json
{
  "functionID": 0, // Required
  "value": "string | null" // Required: Serialized value
}
```

**Response 200:**

```json
{}
```

**Side Effects**: Must wake up any `getEvent` polling for this workflow+key.

---

### Get Event (Polling)

#### GET /workflows/{workflowID}/events/{key}

Get an event value. SDK polls this endpoint.

**Path Parameters:**

- `workflowID` (string): Workflow UUID
- `key` (string): Event key

**Query Parameters:**

- `callerWorkflowID` (string, optional): Caller's workflow ID
- `callerFunctionID` (number, optional): Caller's function ID
- `callerTimeoutFunctionID` (number, optional): Caller's timeout function ID

**Response 200** (event set):

```json
{
  "value": "string | null",
  "found": true
}
```

**Response 200** (event not set):

```json
{
  "value": null,
  "found": false
}
```

**Polling**: SDK polls every 1000ms with timeout. Consider long-polling.

---

## Event Dispatch Endpoints

### Get Event Dispatch State

#### GET /event-dispatch/{service}/{workflowFnName}/{key}

Get external event dispatch state.

**Path Parameters:**

- `service` (string): Service name
- `workflowFnName` (string): Workflow function name
- `key` (string): State key

**Response 200:**

```json
{
  "service_name": "string",
  "workflow_fn_name": "string",
  "key": "string",
  "value": "string",
  "update_time": 1234567890,
  "update_seq": 123
}
```

**Response 404** (not found):

```json
null
```

---

### Upsert Event Dispatch State

#### PUT /event-dispatch

Create or update event dispatch state.

**Request Body:**

```json
{
  "service_name": "string", // Required
  "workflow_fn_name": "string", // Required
  "key": "string", // Required
  "value": "string", // Optional
  "update_time": 1234567890, // Optional
  "update_seq": 123 // Optional
}
```

**Response 200:**

```json
{
  "service_name": "string",
  "workflow_fn_name": "string",
  "key": "string",
  "value": "string",
  "update_time": 1234567890,
  "update_seq": 123
}
```

**Atomicity**: Upsert must be atomic with optimistic locking on `update_seq`.

---

## Stream Endpoints

### Write to Stream

#### POST /workflows/{workflowID}/streams/{key}

Write a value to a stream.

**Path Parameters:**

- `workflowID` (string): Workflow UUID
- `key` (string): Stream key

**Request Body:**

```json
{
  "fromWorkflow": true, // Required: true if from workflow, false if from step
  "functionID": 0, // Required if fromWorkflow is true
  "value": {} // Required: Value to write (any JSON)
}
```

**Response 200:**

```json
{}
```

---

### Close Stream

#### POST /workflows/{workflowID}/streams/{key}/close

Close a stream.

**Path Parameters:**

- `workflowID` (string): Workflow UUID
- `key` (string): Stream key

**Request Body:**

```json
{
  "functionID": 0 // Required
}
```

**Response 200:**

```json
{}
```

---

### Read from Stream

#### GET /workflows/{workflowID}/streams/{key}/{offset}

Read from a stream at a specific offset.

**Path Parameters:**

- `workflowID` (string): Workflow UUID
- `key` (string): Stream key
- `offset` (number): Read offset

**Response 200:**

```json
{
  "value": {}, // The value at this offset (any JSON)
  "closed": false // Whether stream is closed
}
```

If stream is closed and offset is past the end, return `closed: true`.

---

## Admin Endpoints

### Garbage Collect

#### POST /admin/garbage-collect

Clean up old workflow data.

**Request Body:**

```json
{
  "cutoffEpochTimestampMs": 1234567890, // Optional: Delete before this time
  "rowsThreshold": 10000 // Optional: Max rows to keep
}
```

**Response 200:**

```json
{}
```

---

### Get Metrics

#### GET /admin/metrics

Get workflow metrics.

**Query Parameters:**

- `startTime` (string, required): RFC 3339 timestamp
- `endTime` (string, required): RFC 3339 timestamp

**Response 200:**

```json
[
  {
    "metricType": "string",
    "metricName": "string",
    "value": 123
  }
]
```

---

### Check Patch

#### GET /workflows/{workflowID}/patch/{functionID}

Check if a function has been patched.

**Path Parameters:**

- `workflowID` (string): Workflow UUID
- `functionID` (number): Function ID

**Query Parameters:**

- `patchName` (string, required): Name of the patch
- `deprecated` (boolean, required): Whether checking for deprecated patch

**Response 200:**

```json
{
  "isPatched": false,
  "hasEntry": false
}
```

---

## Implementation Notes

### Atomicity Requirements

The following endpoints require atomic/transactional implementation:

1. **POST /workflows** - Conflict detection and status assignment must be atomic
2. **POST /workflows/{id}/operations** - When `checkConflict` is true
3. **POST /queues/{name}/start-workflows** - Finding and marking must be atomic
4. **PUT /event-dispatch** - Optimistic locking on `update_seq`

### Polling Endpoints

These endpoints are polled by the SDK:

| Endpoint                         | Poll Interval | Notes                             |
| -------------------------------- | ------------- | --------------------------------- |
| GET /workflows/{id}/result       | 1000ms        | Until workflow completes          |
| GET /workflows/{id}/messages     | 1000ms        | Until message received or timeout |
| GET /workflows/{id}/events/{key} | 1000ms        | Until event set or timeout        |

Consider implementing long-polling (hold connection until data available or timeout) to reduce request overhead.

### Serialization

All `input`, `output`, `error`, `value`, and `message` fields contain serialized JSON strings. The SDK uses `superjson` for serialization which supports:

- Date objects
- BigInt
- Map/Set
- undefined
- Regular expressions
- Custom class instances (with registration)

The backend should store these as opaque strings and return them unchanged.

### Status Values

Valid workflow statuses:

- `PENDING` - Workflow is running
- `SUCCESS` - Completed successfully
- `ERROR` - Completed with error
- `ENQUEUED` - Waiting in queue
- `CANCELLED` - Cancelled by user
- `MAX_RECOVERY_ATTEMPTS_EXCEEDED` - Failed after max retries

---

## Database Schema for Laravel

Laravel must implement the database tables that store workflow state. This section documents the required schema.

### Table: workflow_status

Primary table for workflow state.

```sql
CREATE TABLE workflow_status (
    workflow_uuid VARCHAR(255) PRIMARY KEY,
    status VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,                    -- workflowName
    class_name VARCHAR(255),                       -- workflowClassName
    config_name VARCHAR(255),                      -- workflowConfigName
    authenticated_user VARCHAR(255) NOT NULL DEFAULT '',
    output TEXT,                                   -- Serialized JSON
    error TEXT,                                    -- Serialized error
    assumed_role VARCHAR(255) NOT NULL DEFAULT '',
    authenticated_roles TEXT NOT NULL DEFAULT '[]', -- Serialized JSON array
    request TEXT NOT NULL DEFAULT '{}',            -- Serialized JSON object
    executor_id VARCHAR(255) NOT NULL,
    application_version VARCHAR(255),
    queue_name VARCHAR(255),
    created_at BIGINT NOT NULL,                    -- Unix timestamp ms
    updated_at BIGINT NOT NULL,                    -- Unix timestamp ms
    application_id VARCHAR(255) NOT NULL,
    recovery_attempts INT NOT NULL DEFAULT 0,
    workflow_timeout_ms BIGINT,
    workflow_deadline_epoch_ms BIGINT,
    inputs TEXT,                                   -- Serialized JSON
    started_at_epoch_ms BIGINT,
    deduplication_id VARCHAR(255),
    priority INT NOT NULL DEFAULT 0,
    queue_partition_key VARCHAR(255),
    forked_from VARCHAR(255),
    owner_xid VARCHAR(255),

    -- Indexes for common queries
    INDEX idx_status (status),
    INDEX idx_executor (executor_id),
    INDEX idx_created_at (created_at),
    INDEX idx_queue_name (queue_name),
    INDEX idx_deduplication (queue_name, deduplication_id),
    INDEX idx_pending_recovery (status, executor_id, application_version)
);
```

### Table: operation_outputs

Stores results of individual workflow steps/operations.

```sql
CREATE TABLE operation_outputs (
    workflow_uuid VARCHAR(255) NOT NULL,
    function_id INT NOT NULL,
    output TEXT,                                   -- Serialized JSON
    error TEXT,                                    -- Serialized error
    child_workflow_id VARCHAR(255),
    function_name VARCHAR(255),
    started_at_epoch_ms BIGINT,
    completed_at_epoch_ms BIGINT,

    PRIMARY KEY (workflow_uuid, function_id),
    FOREIGN KEY (workflow_uuid) REFERENCES workflow_status(workflow_uuid) ON DELETE CASCADE,
    INDEX idx_child_workflow (child_workflow_id)
);
```

### Table: notifications

Stores messages sent between workflows.

```sql
CREATE TABLE notifications (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    destination_uuid VARCHAR(255) NOT NULL,
    topic VARCHAR(255),
    message TEXT,                                  -- Serialized JSON
    created_at BIGINT NOT NULL,
    consumed BOOLEAN NOT NULL DEFAULT FALSE,

    INDEX idx_destination_topic (destination_uuid, topic, consumed),
    FOREIGN KEY (destination_uuid) REFERENCES workflow_status(workflow_uuid) ON DELETE CASCADE
);
```

### Table: workflow_events

Stores key-value events set by workflows.

```sql
CREATE TABLE workflow_events (
    workflow_uuid VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL,
    value TEXT,                                    -- Serialized JSON

    PRIMARY KEY (workflow_uuid, key),
    FOREIGN KEY (workflow_uuid) REFERENCES workflow_status(workflow_uuid) ON DELETE CASCADE
);
```

### Table: event_dispatch_kv

Stores external event dispatch state for idempotency.

```sql
CREATE TABLE event_dispatch_kv (
    service_name VARCHAR(255) NOT NULL,
    workflow_fn_name VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL,
    value TEXT,                                    -- Serialized JSON
    update_time BIGINT,
    update_seq BIGINT,

    PRIMARY KEY (service_name, workflow_fn_name, key),
    INDEX idx_update_seq (update_seq)
);
```

### Table: workflow_streams

Stores stream data for workflow streaming.

```sql
CREATE TABLE workflow_streams (
    workflow_uuid VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL,
    offset INT NOT NULL,
    value TEXT NOT NULL,                           -- Serialized JSON
    is_closed BOOLEAN NOT NULL DEFAULT FALSE,

    PRIMARY KEY (workflow_uuid, key, offset),
    FOREIGN KEY (workflow_uuid) REFERENCES workflow_status(workflow_uuid) ON DELETE CASCADE
);
```

### Table: workflow_queue_state (Optional)

For tracking queue concurrency and rate limiting. Can be managed in-memory if preferred.

```sql
CREATE TABLE workflow_queue_state (
    queue_name VARCHAR(255) NOT NULL,
    partition_key VARCHAR(255) NOT NULL DEFAULT '',
    running_count INT NOT NULL DEFAULT 0,
    last_started_at BIGINT,

    PRIMARY KEY (queue_name, partition_key)
);
```

### Laravel Migration Example

```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('workflow_status', function (Blueprint $table) {
            $table->string('workflow_uuid')->primary();
            $table->string('status', 50);
            $table->string('name');
            $table->string('class_name')->nullable();
            $table->string('config_name')->nullable();
            $table->string('authenticated_user')->default('');
            $table->text('output')->nullable();
            $table->text('error')->nullable();
            $table->string('assumed_role')->default('');
            $table->text('authenticated_roles')->default('[]');
            $table->text('request')->default('{}');
            $table->string('executor_id');
            $table->string('application_version')->nullable();
            $table->string('queue_name')->nullable();
            $table->bigInteger('created_at');
            $table->bigInteger('updated_at');
            $table->string('application_id');
            $table->integer('recovery_attempts')->default(0);
            $table->bigInteger('workflow_timeout_ms')->nullable();
            $table->bigInteger('workflow_deadline_epoch_ms')->nullable();
            $table->text('inputs')->nullable();
            $table->bigInteger('started_at_epoch_ms')->nullable();
            $table->string('deduplication_id')->nullable();
            $table->integer('priority')->default(0);
            $table->string('queue_partition_key')->nullable();
            $table->string('forked_from')->nullable();
            $table->string('owner_xid')->nullable();

            $table->index('status');
            $table->index('executor_id');
            $table->index('created_at');
            $table->index('queue_name');
            $table->index(['queue_name', 'deduplication_id']);
            $table->index(['status', 'executor_id', 'application_version']);
        });

        Schema::create('operation_outputs', function (Blueprint $table) {
            $table->string('workflow_uuid');
            $table->integer('function_id');
            $table->text('output')->nullable();
            $table->text('error')->nullable();
            $table->string('child_workflow_id')->nullable();
            $table->string('function_name')->nullable();
            $table->bigInteger('started_at_epoch_ms')->nullable();
            $table->bigInteger('completed_at_epoch_ms')->nullable();

            $table->primary(['workflow_uuid', 'function_id']);
            $table->foreign('workflow_uuid')
                  ->references('workflow_uuid')
                  ->on('workflow_status')
                  ->onDelete('cascade');
            $table->index('child_workflow_id');
        });

        Schema::create('notifications', function (Blueprint $table) {
            $table->id();
            $table->string('destination_uuid');
            $table->string('topic')->nullable();
            $table->text('message')->nullable();
            $table->bigInteger('created_at');
            $table->boolean('consumed')->default(false);

            $table->index(['destination_uuid', 'topic', 'consumed']);
            $table->foreign('destination_uuid')
                  ->references('workflow_uuid')
                  ->on('workflow_status')
                  ->onDelete('cascade');
        });

        Schema::create('workflow_events', function (Blueprint $table) {
            $table->string('workflow_uuid');
            $table->string('key');
            $table->text('value')->nullable();

            $table->primary(['workflow_uuid', 'key']);
            $table->foreign('workflow_uuid')
                  ->references('workflow_uuid')
                  ->on('workflow_status')
                  ->onDelete('cascade');
        });

        Schema::create('event_dispatch_kv', function (Blueprint $table) {
            $table->string('service_name');
            $table->string('workflow_fn_name');
            $table->string('key');
            $table->text('value')->nullable();
            $table->bigInteger('update_time')->nullable();
            $table->bigInteger('update_seq')->nullable();

            $table->primary(['service_name', 'workflow_fn_name', 'key']);
            $table->index('update_seq');
        });

        Schema::create('workflow_streams', function (Blueprint $table) {
            $table->string('workflow_uuid');
            $table->string('key');
            $table->integer('offset');
            $table->text('value');
            $table->boolean('is_closed')->default(false);

            $table->primary(['workflow_uuid', 'key', 'offset']);
            $table->foreign('workflow_uuid')
                  ->references('workflow_uuid')
                  ->on('workflow_status')
                  ->onDelete('cascade');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('workflow_streams');
        Schema::dropIfExists('event_dispatch_kv');
        Schema::dropIfExists('workflow_events');
        Schema::dropIfExists('notifications');
        Schema::dropIfExists('operation_outputs');
        Schema::dropIfExists('workflow_status');
    }
};
```

### Key Implementation Notes for Laravel

1. **Atomic Operations**: Use database transactions for:

   - `POST /workflows` - Check-and-insert must be atomic
   - `POST /queues/{name}/start-workflows` - Finding and updating must be atomic
   - `PUT /event-dispatch` - Optimistic locking on `update_seq`

2. **Soft Real-time**: For polling endpoints (`/result`, `/messages`, `/events`), consider:

   - Long-polling with timeout
   - Or Laravel broadcasting with Pusher/WebSockets

3. **Cleanup**: The `POST /admin/garbage-collect` endpoint should delete:

   - Completed workflows older than `cutoffEpochTimestampMs`
   - Associated operation_outputs, notifications, events, streams

4. **Serialization**: All `output`, `error`, `value`, `message`, `inputs` fields are opaque JSON strings. Store as TEXT and return unchanged.

---

## Version

API Schema Version: 1.0.0
Generated for DBOS SDK HTTP Transport
