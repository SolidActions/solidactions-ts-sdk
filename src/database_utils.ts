/**
 * URL utilities for database connection strings.
 * These are kept for backwards compatibility with configuration parsing.
 */

/**
 * Derive a new database URL with a different database name.
 */
export function deriveDatabaseUrl(urlStr: string, otherDbName: string): string {
  try {
    const u = new URL(urlStr);
    u.pathname = `/${otherDbName}`;
    return u.toString();
  } catch {
    return urlStr;
  }
}

/**
 * Extract the database name from a PostgreSQL URL.
 */
export function getDatabaseNameFromUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return u.pathname?.replace(/^\//, '') || '';
  } catch {
    return '';
  }
}

/**
 * Mask the password in a database URL for safe logging.
 */
export function maskDatabaseUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    if (u.password) {
      const p = decodeURIComponent(u.password);
      const masked = p.length <= 2 ? p : `${p[0]}${'*'.repeat(p.length - 2)}${p[p.length - 1]}`;
      u.password = encodeURIComponent(masked);
    }
    return u.toString();
  } catch {
    return urlStr;
  }
}
