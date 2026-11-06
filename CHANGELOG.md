# Changelog

## 0.10.0

MINOR: Add `ctx.docs`, a run-scoped client for the workspace's docs that acts as the project (the app): `read`, `list`, `search`, `create`, `write`, `append`, `prepend`, `updateProperties`, `setType`, `rename`, `move`, `copy`, `trash`, `restore` and `createFolder`. Add `env: - NAME: { docs: "Folder/Path" }` mappings, surfaced as a `DocsVar` at `ctx.vars.NAME` (and typed by `generateVarsTypes`; `docs` is now a kind in `VarsDeclarations`). Add `createDocsClient` and `SolidActionsDocsError` (`code`, `status`, `path?`, `message`, `details?`). `SA_VIEWER_ID`, `SA_VIEWER_TYPE` and `SA_VIEWER_NAME` are reserved and never appear in `ctx.vars`. A `DocsVar` survives suspend and replay. The docs mapping needs an app release that ships docs access for apps and a CLI release that sends `yaml_default_docs_path`.

## 0.9.0

MINOR: Add `createAnalyticalDatabaseClient` for durable inline and staged-file analytical database ingest. Generated `database:` mappings now use the `DatabaseVar | AnalyticalDatabaseBinding` union; applications that handle both database kinds can narrow on `typeof binding === 'string'`.
