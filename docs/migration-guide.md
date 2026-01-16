# Migration Guide: DBOS SDK PostgreSQL to HTTP

This guide covers migrating from the PostgreSQL-based DBOS SDK to the HTTP-based SDK.

## Overview

The DBOS TypeScript SDK has been refactored to use HTTP API calls instead of direct PostgreSQL database access. This change:

- **Removes** all PostgreSQL dependencies from the SDK
- **Requires** an HTTP API backend (Laravel) to handle workflow state
- **Simplifies** SDK deployment (no database credentials needed)

## Breaking Changes

### Configuration Changes

**Before (PostgreSQL):**

```yaml
# dbos-config.yaml
name: my-app
system_database: postgresql://user:pass@localhost:5432/myapp_dbos_sys
```

```typescript
// Code
DBOS.setConfig({
  name: 'my-app',
  systemDatabaseUrl: 'postgresql://user:pass@localhost:5432/myapp_dbos_sys',
});
```

**After (HTTP):**

```yaml
# dbos-config.yaml
name: my-app
api:
  url: https://api.example.com
  key: your-api-key
  timeout: 30000 # Optional: ms (default: 30000)
  maxRetries: 3 # Optional (default: 3)
```

```typescript
// Code
DBOS.setConfig({
  name: 'my-app',
  httpConfig: {
    apiUrl: 'https://api.example.com',
    apiKey: 'your-api-key',
    timeout: 30000,
    maxRetries: 3,
  },
});
```

### Environment Variables

**Before:**

```bash
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=mypassword
PGDATABASE=myapp_dbos_sys
# or
DATABASE_URL=postgresql://user:pass@localhost:5432/myapp_dbos_sys
```

**After:**

```bash
DBOS_API_URL=https://api.example.com
DBOS_API_KEY=your-api-key
```

### Removed Exports

The following exports have been removed from the SDK:

```typescript
// These no longer exist:
import { PostgresSystemDatabase } from '@dbos-inc/dbos-sdk'; // Removed
import { Pool } from 'pg'; // No longer a dependency

// Use instead:
import { HttpSystemDatabase } from '@dbos-inc/dbos-sdk';
import { HttpClient } from '@dbos-inc/dbos-sdk';
```

### Removed Functions

```typescript
// These functions are no longer available:
dropPGDatabase(); // Removed
ensurePGDatabase(); // Removed
connectToPGDatabase(); // Removed
getSystemDatabaseUrl(); // Removed
getPGClientConfig(); // Removed
```

### New Error Types

The SDK now includes HTTP-specific error types:

```typescript
import {
  DBOSHttpError, // Base HTTP error
  DBOSUnauthorizedError, // 401 responses
  DBOSForbiddenError, // 403 responses
  DBOSNotFoundError, // 404 responses
  DBOSRateLimitedError, // 429 responses
  DBOSServerError, // 5xx responses
  DBOSNetworkError, // Network failures
} from '@dbos-inc/dbos-sdk';
```

## Migration Steps

### Step 1: Update Configuration

Replace your database configuration with HTTP configuration:

```typescript
// Before
const config = {
  name: 'my-app',
  systemDatabaseUrl: process.env.DATABASE_URL,
};

// After
const config = {
  name: 'my-app',
  httpConfig: {
    apiUrl: process.env.DBOS_API_URL,
    apiKey: process.env.DBOS_API_KEY,
  },
};

DBOS.setConfig(config);
```

### Step 2: Update Environment Variables

Update your deployment environment:

```bash
# Remove these
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE DATABASE_URL

# Add these
export DBOS_API_URL=https://your-laravel-api.com
export DBOS_API_KEY=your-bearer-token
```

### Step 3: Deploy Laravel Backend

Before your SDK can work, you need to deploy the Laravel API backend that implements the DBOS HTTP API. See `docs/api-schema.md` for the complete API specification.

### Step 4: Update DBOSClient Usage

If you use `DBOSClient` directly:

```typescript
// Before
const client = await DBOSClient.create({
  systemDatabaseUrl: 'postgresql://...',
});

// After
const client = await DBOSClient.create({
  httpConfig: {
    apiUrl: 'https://api.example.com',
    apiKey: 'your-api-key',
  },
});
```

### Step 5: Update Error Handling

Update any error handling code to handle new HTTP error types:

```typescript
try {
  await workflow.execute();
} catch (error) {
  if (error instanceof DBOSUnauthorizedError) {
    // Handle 401 - invalid API key
  } else if (error instanceof DBOSRateLimitedError) {
    // Handle 429 - rate limited
    const retryAfter = error.retryAfter;
  } else if (error instanceof DBOSServerError) {
    // Handle 5xx - server error
  } else if (error instanceof DBOSNetworkError) {
    // Handle network failure
  }
}
```

### Step 6: Remove PostgreSQL Dependencies

Update your `package.json`:

```bash
npm uninstall pg @types/pg
```

## Phase 12: Simplified APIs

The SolidSteps SDK includes simplified APIs that reduce boilerplate for common patterns.

### `DBOS.run()` - One-Liner Entry Point

**Before (verbose pattern):**

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

async function main() {
  DBOS.setConfig({
    name: 'my-app',
    api: {
      url: process.env.DBOS_API_URL!,
      key: process.env.DBOS_API_KEY!,
    },
  });

  await DBOS.launch();

  const input = process.env.WORKFLOW_INPUT ? JSON.parse(process.env.WORKFLOW_INPUT) : {};

  const handle = await DBOS.startWorkflow(myWorkflow)(input);
  await handle.getResult();

  await DBOS.shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**After (one-liner):**

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

const wf = DBOS.registerWorkflow(myWorkflow, { name: 'my-workflow' });
DBOS.run(wf);
```

`DBOS.run()` automatically:

1. Reads config from `solidsteps.yaml` + environment variables (no `setConfig()` needed)
2. Calls `launch()`
3. Parses `WORKFLOW_INPUT` environment variable via `getInput()`
4. Runs the workflow and awaits result
5. Calls `shutdown()` and exits with appropriate code

### `DBOS.getInput<T>()` - Typed Input Access

**Before:**

```typescript
const rawInput = process.env.WORKFLOW_INPUT || '{}';
let input: MyInputType;
try {
  input = JSON.parse(rawInput);
} catch {
  input = {} as MyInputType;
}
```

**After:**

```typescript
interface MyInputType {
  taskId: string;
  value: number;
}

const input = DBOS.getInput<MyInputType>();
// Returns {} if WORKFLOW_INPUT not set or invalid JSON
```

### `DBOS.getSignalUrls()` - Signal URL Generation

**Before (manual URL construction):**

```typescript
const workflowId = DBOS.workflowID;
const baseUrl = process.env.APP_URL;
const approveUrl = `${baseUrl}/api/signal/${workflowId}?choice=approve&topic=approval`;
const rejectUrl = `${baseUrl}/api/signal/${workflowId}?choice=reject&topic=approval`;
```

**After:**

```typescript
const urls = DBOS.getSignalUrls('approval');
// Returns:
// {
//   base: "http://localhost:8000/api/signal/{workflowId}",
//   approve: "http://localhost:8000/api/signal/{workflowId}?choice=approve&topic=approval",
//   reject: "http://localhost:8000/api/signal/{workflowId}?choice=reject&topic=approval",
//   custom: (action) => "http://localhost:8000/api/signal/{workflowId}?choice={action}&topic=approval"
// }

// Use in email templates:
await sendEmail({
  to: invoice.email,
  subject: 'Invoice Approval',
  body: `
    <a href="${urls.approve}">Approve</a>
    <a href="${urls.reject}">Reject</a>
  `,
});
```

### Auto-Configuration from `solidsteps.yaml`

When `setConfig()` is not called, `launch()` automatically configures from:

1. Project name from `solidsteps.yaml`
2. API URL from `DBOS_API_URL` environment variable
3. API key from `DBOS_API_KEY` environment variable

This means tenant workflows can be as simple as:

```typescript
import { DBOS } from '@dbos-inc/dbos-sdk';

async function processOrder(input: OrderInput): Promise<OrderResult> {
  const validated = await DBOS.runStep(() => validateOrder(input), {
    name: 'validate-order',
  });

  await DBOS.sleep(1000); // 1 second delay

  return await DBOS.runStep(() => fulfillOrder(validated), {
    name: 'fulfill-order',
  });
}

const wf = DBOS.registerWorkflow(processOrder, { name: 'process-order' });
DBOS.run(wf);
```

## Behavioral Changes

### Polling vs Notifications

**Before (PostgreSQL):** Used PostgreSQL LISTEN/NOTIFY for real-time updates.

**After (HTTP):** Uses polling for operations like:

- Waiting for workflow results
- Receiving messages
- Getting events

The SDK polls every 1 second by default. For high-throughput applications, consider implementing long-polling or WebSocket support in your Laravel backend.

### Retry Logic

The HTTP client includes built-in retry logic:

- Retries on 5xx errors and network failures
- Uses exponential backoff with jitter
- Respects `Retry-After` headers
- Does NOT retry on 4xx errors (client errors)

### Connection Management

**Before:** SDK managed a PostgreSQL connection pool.

**After:** SDK uses stateless HTTP requests. Each operation is independent.

## Testing

### Unit Tests

Replace PostgreSQL test containers with the mock HTTP server:

```typescript
import { createMockServer, MockHttpServer } from '@dbos-inc/dbos-sdk/tests/http_mock_server';

let mockServer: MockHttpServer;

beforeAll(async () => {
  mockServer = await createMockServer();
});

afterAll(async () => {
  await mockServer.stop();
});

test('my workflow test', async () => {
  const client = await DBOSClient.create({
    httpConfig: {
      apiUrl: mockServer.baseUrl,
      apiKey: 'test-key',
    },
  });

  // Your test code
});
```

### Integration Tests

For integration tests, point at your Laravel backend:

```typescript
const client = await DBOSClient.create({
  httpConfig: {
    apiUrl: process.env.DBOS_TEST_API_URL,
    apiKey: process.env.DBOS_TEST_API_KEY,
  },
});
```

## FAQ

### Why was this change made?

1. **Simplified deployment** - SDK consumers don't need database credentials
2. **Better separation of concerns** - Backend owns database, SDK is a pure client
3. **Multi-tenancy support** - Laravel can handle tenant isolation
4. **Easier scaling** - Stateless HTTP calls scale better than connection pools

### What if I need direct database access?

The SDK no longer supports direct database access. All workflow state must go through the HTTP API. If you need custom database operations, implement them as API endpoints in your Laravel backend.

### How do I handle high-throughput scenarios?

1. Implement long-polling in your Laravel backend
2. Consider WebSocket support for real-time updates
3. Adjust `maxRetries` and `timeout` in your config
4. Use queue-based workflows for batch operations

### What about existing workflows in my database?

Existing workflow data must be migrated to the new Laravel-managed database. The schema is documented in `docs/api-schema.md`. You'll need to:

1. Export existing workflow data from your PostgreSQL database
2. Import it into Laravel's database
3. Point your SDK at the new Laravel API

## Support

For issues with this migration:

- Check the API schema documentation: `docs/api-schema.md`
- Review the HTTP client source: `src/http_client.ts`
- Open an issue on GitHub
