# Changelog

## 0.9.0

MINOR: Add `createAnalyticalDatabaseClient` for durable inline and staged-file analytical database ingest. Generated `database:` mappings now use the `DatabaseVar | AnalyticalDatabaseBinding` union; applications that handle both database kinds can narrow on `typeof binding === 'string'`.
