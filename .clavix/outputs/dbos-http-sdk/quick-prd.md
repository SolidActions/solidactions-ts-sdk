# DBOS HTTP SDK Conversion - Quick PRD

**Goal:** Modify the DBOS TypeScript SDK to replace all direct PostgreSQL database operations with HTTP API calls. The SDK should only require an API endpoint URL and API key for authentication - no database credentials. Laravel will serve as the API backend, owning the sole database connection. This is a clean break with no backward compatibility - HTTP transport only.

**Core Requirements:** (1) Replace every Postgres read/write operation with an equivalent HTTP call, preserving all existing functionality (workflow state, step caching, signals, sleeps). (2) Generate comprehensive API schema documentation for Laravel implementation, including request/response formats and atomicity requirements where transactions are currently used. (3) Implement error handling best practices: 4xx errors throw immediately without retry, 5xx and network errors retry with exponential backoff + jitter (max 3 attempts), respect Retry-After headers. (4) Authentication via `Authorization: Bearer <api-key>` header (standard Laravel Sanctum pattern).

**Boundaries:** No new features - this is a 1:1 transport layer replacement. No dual-mode support, no user migration, no WebSocket/real-time additions. Multi-tenancy is Laravel's concern (SDK just passes API key, Laravel determines tenant). Deliverables: modified SDK with HTTP transport, complete API schema documentation, and list of removed Postgres dependencies.

---

_Generated with Clavix Planning Mode_
_Generated: 2026-01-10T03:35:00Z_
