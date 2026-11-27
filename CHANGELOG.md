# Changelog

## 0.12.0

MINOR: Step retry settings now work on hosted runs. `retriesAllowed`, `intervalSeconds`, `maxAttempts` and `backoffRate` on `SolidActions.runStep()` were accepted but ignored, so a failing step ran once; `ctx.step()` now accepts them too. They take effect after you upgrade the SDK and redeploy. `maxAttempts` counts all attempts (default 3), waits start at 1 second and double, each at most 3600 seconds, and when every attempt fails the step throws `SolidActionsMaxStepRetriesError`. Waits count toward run time. Inside a retried step, nested steps, `now()`, `randomUUID()` and `sleep()` are ordinary calls.

### Breaking for steps that set retries

- A step with `retriesAllowed: true` that calls `send` or `recv` (on `ctx` or `SolidActions`) or `SolidActions.setEvent`, or starts a child workflow, now fails with "not allowed inside a step". Move the call out of the step. Steps without retries are unchanged.
- A step with `retriesAllowed: true` that fails now throws `SolidActionsMaxStepRetriesError`, not its own error. The original errors are in `.errors`. Code that checks the caught error's class or fields must change; after a replay the caught error is a plain `Error` with the same message, so `instanceof` holds only on the first run.
- A run interrupted in the middle of a retried step that makes a nested step, `now()` or `randomUUID()` call, and resumed after you redeploy, may read the wrong recorded results. Let such runs finish before you redeploy.

## 0.11.1

PATCH: Document DuckDB database files (`openAnalytics`, `db.step`, `db.publish`) in the README and SDK reference, and remove internal ticket tags from the shipped comments.

## 0.11.0

MINOR: Add `openAnalytics` for DuckDB databases: `openAnalytics(binding, { readOnly?, directory?, leaseWaitSeconds? })` restores the newest version of a database into a work folder as a `<name>.duckdb` file and returns a handle with `path`, `version`, `readOnly`, `step(name, fn)` (a durable step that uploads a save point), `save()` and `publish()`. A write open holds a renewed lease and records the version the run started from, so a publish never replaces a version the run was not built on (`base_moved`). Add `AnalyticsError` (`code`, `status?`, `details?`); the codes the SDK raises itself are listed in the SDK reference. It needs a server that has DuckDB databases switched on, and Node.js 24 or newer.

## 0.10.0

MINOR: Add `ctx.docs`, a run-scoped client for the workspace's docs that acts as the project (the app): `read`, `list`, `search`, `create`, `write`, `append`, `prepend`, `updateProperties`, `setType`, `rename`, `move`, `copy`, `trash`, `restore` and `createFolder`. Add `env: - NAME: { docs: "Folder/Path" }` mappings, surfaced as a `DocsVar` at `ctx.vars.NAME` (and typed by `generateVarsTypes`; `docs` is now a kind in `VarsDeclarations`). Add `createDocsClient` and `SolidActionsDocsError` (`code`, `status`, `path?`, `message`, `details?`). `SA_VIEWER_ID`, `SA_VIEWER_TYPE` and `SA_VIEWER_NAME` are reserved and never appear in `ctx.vars`. A `DocsVar` survives suspend and replay. The docs mapping needs an app release that ships docs access for apps and a CLI release that sends `yaml_default_docs_path`.

## 0.9.0

MINOR: Add `createAnalyticalDatabaseClient` for durable inline and staged-file analytical database ingest. Generated `database:` mappings now use the `DatabaseVar | AnalyticalDatabaseBinding` union; applications that handle both database kinds can narrow on `typeof binding === 'string'`.
