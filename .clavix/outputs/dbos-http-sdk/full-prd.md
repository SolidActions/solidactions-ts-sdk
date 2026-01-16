# Product Requirements Document: DBOS HTTP SDK Conversion

## Problem & Goal

**Problem:** The DBOS TypeScript SDK currently requires direct PostgreSQL database credentials to function. This creates credential management overhead, tight coupling between SDK consumers and the database layer, and security concerns around distributing database access.

**Goal:** Replace all direct database operations in the SDK with HTTP API calls. SDK consumers should only need:

- An API endpoint URL
- An API key (auth token)

Laravel will serve as the API backend, owning the sole database connection. This decouples SDK users from database infrastructure entirely.

## Requirements

### Must-Have Features

1. **Replace All Postgres Operations with HTTP Calls**

   - Identify every Postgres read/write operation in the current SDK
   - Create corresponding HTTP endpoints that mirror these operations
   - SDK calls HTTP API instead of direct database queries
   - Preserve all existing functionality (workflow state, step caching, signals, sleeps)

2. **API Schema Documentation**

   - Document all required HTTP endpoints
   - Include request/response schemas for each endpoint
   - Note atomicity requirements (where current code uses transactions)
   - Format: OpenAPI/Swagger or detailed markdown

3. **Error Handling (Best Practices)**
   | HTTP Status | SDK Behavior |
   |-------------|--------------|
   | 2xx | Success - return data |
   | 400 Bad Request | Throw validation error (don't retry) |
   | 401 Unauthorized | Throw auth error (don't retry) |
   | 404 Not Found | Throw not found error (don't retry) |
   | 409 Conflict | Throw conflict error (don't retry) |
   | 429 Rate Limited | Retry with backoff (respect Retry-After header) |
   | 5xx Server Error | Retry with exponential backoff |
   | Network Error | Retry with exponential backoff |

4. **Retry Logic (Best Practices)**

   - Exponential backoff with jitter (prevents thundering herd)
   - Maximum 3 retry attempts for transient failures
   - Only retry 5xx errors and network failures (not 4xx client errors)
   - Configurable request timeout
   - Respect `Retry-After` header when present

5. **Authentication**
   - API key authentication via `Authorization: Bearer <key>` header
   - Standard Laravel Sanctum / API token pattern
   - SDK accepts API key in configuration

### Technical Requirements

**SDK Side (TypeScript):**

- Remove all direct Postgres/pg dependencies
- Add HTTP client (fetch or axios)
- Implement retry logic with exponential backoff
- Map HTTP errors to appropriate SDK exceptions
- Configuration: API URL + API key (instead of DB connection string)

**API Side (Laravel):**

- RESTful endpoints mirroring current DB operations
- API key authentication (Sanctum or custom)
- Atomic operations where current SDK uses transactions
- Proper HTTP status codes for all error conditions
- JSON request/response format

**Transport:**

- HTTPS only (TLS required)
- JSON content type
- Standard REST conventions

## Out of Scope

| Excluded                           | Rationale                                       |
| ---------------------------------- | ----------------------------------------------- |
| Backward compatibility (dual-mode) | Clean break - HTTP only, simplifies maintenance |
| User migration support             | Not migrating existing users                    |
| New features                       | 1:1 replacement only, no feature additions      |
| Multi-tenancy in SDK               | Laravel handles tenant scoping via API key      |
| WebSocket/real-time support        | Not in current SDK, not adding                  |
| Batch/bulk operations              | Only if already exists in current SDK           |
| SDK-side caching                   | Keep SDK stateless, caching is server concern   |
| Mobile SDK variants                | TypeScript/Node only                            |

## Success Criteria

1. **Functional:** SDK can execute all current workflows without database credentials
2. **Parity:** All existing DBOS functionality works identically over HTTP
3. **Documentation:** Complete API schema ready for Laravel implementation
4. **Clean:** All Postgres dependencies removed from SDK
5. **Robust:** Proper error handling and retry logic for network failures

## Implementation Approach

### Phase 1: Analysis

1. Audit current SDK codebase for all Postgres operations
2. Document each operation's purpose, inputs, outputs
3. Identify transaction boundaries (atomicity requirements)
4. Map current exceptions to HTTP error codes

### Phase 2: API Design

1. Design HTTP endpoints mirroring DB operations
2. Create OpenAPI/schema documentation
3. Define request/response formats
4. Document atomicity requirements for Laravel

### Phase 3: SDK Modification

1. Remove Postgres client dependencies
2. Implement HTTP client with retry logic
3. Replace all DB calls with HTTP calls
4. Update configuration (URL + API key)
5. Map HTTP errors to SDK exceptions

### Phase 4: Validation

1. Ensure all existing tests pass (with mocked HTTP)
2. Integration testing against Laravel API
3. Document removed dependencies

## Deliverables

1. **Modified SDK** - TypeScript SDK with HTTP transport (no Postgres)
2. **API Schema Documentation** - Complete endpoint specifications for Laravel
3. **Migration Guide** - What changed, new configuration format
4. **Removed Dependencies List** - Postgres packages to remove from package.json

---

_Generated with Clavix Planning Mode_
_Generated: 2026-01-10T03:35:00Z_
