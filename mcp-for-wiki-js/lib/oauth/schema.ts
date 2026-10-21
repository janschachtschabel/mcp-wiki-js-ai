/**
 * Schema and versioned migrations of the OAuth sqlite store (R-44), split
 * from the query layer in ./store.ts.
 */

// node:sqlite types are not in @types/node 20 — keep the surface minimal and local.
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash    TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge    TEXT NOT NULL,
  enc_jwt      TEXT NOT NULL,
  user_label   TEXT NOT NULL,
  user_email   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_sessions (
  id                TEXT PRIMARY KEY,
  access_hash       TEXT NOT NULL UNIQUE,
  refresh_hash      TEXT NOT NULL UNIQUE,
  prev_refresh_hash TEXT,
  client_id         TEXT NOT NULL,
  client_name       TEXT NOT NULL,
  user_label        TEXT NOT NULL,
  user_email        TEXT NOT NULL,
  enc_jwt           TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER NOT NULL,
  revoked_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_email ON oauth_sessions(user_email);
CREATE INDEX IF NOT EXISTS idx_sessions_prev_refresh ON oauth_sessions(prev_refresh_hash);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  session_id TEXT,
  profile    TEXT,
  tool       TEXT NOT NULL,
  category   TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  ms         INTEGER NOT NULL
);
`;

/**
 * Versioned migrations (R-44). SCHEMA above is the pre-versioning (v0) shape;
 * step N brings a store from user_version N to N+1. Every step is additive and
 * guarded, so a store from any earlier release opens and keeps its data.
 */
const MIGRATIONS: Array<(d: SqliteDatabase) => void> = [
  // v1: wiki user id as the session owner (R-41), code tombstones for reuse
  // detection (R-25), indexes for the retention and listing queries (R-44).
  (d) => {
    addColumnIfMissing(d, 'oauth_codes', 'user_id', 'INTEGER');
    addColumnIfMissing(d, 'oauth_codes', 'consumed_at', 'INTEGER');
    addColumnIfMissing(d, 'oauth_codes', 'session_id', 'TEXT');
    addColumnIfMissing(d, 'oauth_sessions', 'user_id', 'INTEGER');
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON oauth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_used ON oauth_sessions(last_used_at);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** The backup sidecar opens the same file; wait for its lock instead of failing (R-43). */
const BUSY_TIMEOUT_MS = 5000;

/** Table/column names are code constants, never input. */
function addColumnIfMissing(d: SqliteDatabase, table: string, column: string, type: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Apply the pending versioned steps, each in its own transaction. */
function migrate(d: SqliteDatabase): void {
  const current = Number(d.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[v](d);
      d.exec(`PRAGMA user_version = ${v + 1}`);
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Pragmas, base schema and pending migrations for a freshly opened handle. */
export function prepareSchema(d: SqliteDatabase): void {
  d.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  d.exec('PRAGMA journal_mode = WAL;');
  // Pre-versioning stores may lack prev_refresh_hash, which the base schema's index needs.
  if (d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oauth_sessions'").get()) {
    addColumnIfMissing(d, 'oauth_sessions', 'prev_refresh_hash', 'TEXT');
  }
  d.exec(SCHEMA);
  migrate(d);
}
