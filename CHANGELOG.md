# Changelog

## 0.11.0

MINOR: Add `openAnalytics` for DuckDB databases: `openAnalytics(binding, { readOnly?, directory?, leaseWaitSeconds? })` restores the newest version of a database into a work folder as a `<name>.duckdb` file and returns a handle with `path`, `version`, `readOnly`, `step(name, fn)` (a durable step that uploads a save point), `save()` and `publish()`. A write open holds a renewed lease and records the version the run started from, so a publish never replaces a version the run was not built on (`base_moved`). Add `AnalyticsError` (`code`, `status?`, `details?`); the codes the SDK raises itself are listed in the SDK reference. It needs a server that has DuckDB databases switched on, and Node.js 24 or newer.

## 0.10.0

MINOR: Add `ctx.docs`, a run-scoped client for the workspace's docs that acts as the project (the app): `read`, `list`, `search`, `create`, `write`, `append`, `prepend`, `updateProperties`, `setType`, `rename`, `move`, `copy`, `trash`, `restore` and `createFolder`. Add `env: - NAME: { docs: "Folder/Path" }` mappings, surfaced as a `DocsVar` at `ctx.vars.NAME` (and typed by `generateVarsTypes`; `docs` is now a kind in `VarsDeclarations`). Add `createDocsClient` and `SolidActionsDocsError` (`code`, `status`, `path?`, `message`, `details?`). `SA_VIEWER_ID`, `SA_VIEWER_TYPE` and `SA_VIEWER_NAME` are reserved and never appear in `ctx.vars`. A `DocsVar` survives suspend and replay. The docs mapping needs an app release that ships docs access for apps and a CLI release that sends `yaml_default_docs_path`.

## 0.9.0

MINOR: Add `createAnalyticalDatabaseClient` for durable inline and staged-file analytical database ingest. Generated `database:` mappings now use the `DatabaseVar | AnalyticalDatabaseBinding` union; applications that handle both database kinds can narrow on `typeof binding === 'string'`.
