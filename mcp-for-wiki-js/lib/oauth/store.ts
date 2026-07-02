/**
 * SQLite-backed persistence for the OAuth layer (clients, codes, sessions, audit).
 *
 * Uses node:sqlite (built into Node >= 22.5, stable in Node 24) so the server
 * gains ZERO new npm dependencies. The DB lives on a small data volume
 * (MCP_DATA_DIR, default ./data) — sessions survive container restarts.
 *
 * NOT available on serverless (Vercel has no persistent disk): there the OAuth
 * layer stays disabled and the legacy handle/env credential paths keep working.
 *
 * All secrets in here are either hashes (tokens, codes) or AES-GCM-encrypted
 * (Wiki.js user JWTs) — see lib/oauth/crypto.ts.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sessionSecret } from './crypto';

/** OAuth is on ⇔ a session secret is configured (checked before any store use). */
export function oauthEnabled(): boolean {
  return Boolean(sessionSecret());
}

export interface ClientRow {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: number;
}

export interface CodeRow {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  encJwt: string;
  userLabel: string;
  userEmail: string;
  expiresAt: number;
}

export interface SessionRow {
  id: string;
  accessHash: string;
  refreshHash: string;
  clientId: string;
  clientName: string;
  userLabel: string;
  userEmail: string;
  encJwt: string;
  accessExpiresAt: number;
  createdAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
}

export interface AuditRow {
  ts: number;
  sessionId: string | null;
  profile: string | null;
  tool: string;
  category: string;
  outcome: string;
  ms: number;
}

// node:sqlite types are not in @types/node 20 — keep the surface minimal and local.
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
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

let db: SqliteDatabase | null = null;

function dataDir(): string {
  return process.env.MCP_DATA_DIR || join(process.cwd(), 'data');
}

/**
 * Load node:sqlite at call time via process.getBuiltinModule (Node >= 22.3).
 * This keeps the builtin out of the bundler's static graph AND out of runtimes
 * that never enable OAuth (stdio on older Node, Vercel serverless).
 */
function loadSqlite(): { DatabaseSync: new (path: string) => SqliteDatabase } {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== 'function') {
    throw new Error('node:sqlite unavailable — the OAuth session store needs Node >= 22.5 (Docker image ships Node 24).');
  }
  return getBuiltin.call(process, 'node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };
}

/** Lazy singleton — opened on first use, shared per process. */
function getDb(): SqliteDatabase {
  if (db) return db;
  if (!oauthEnabled()) throw new Error('OAuth store unavailable: MCP_SESSION_SECRET is not set.');
  const { DatabaseSync } = loadSqlite();
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, 'mcp.sqlite'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Idempotent additive migrations for DBs created by earlier versions. */
function migrate(d: SqliteDatabase): void {
  const cols = d.prepare('PRAGMA table_info(oauth_sessions)').all();
  if (!cols.some((c) => c.name === 'prev_refresh_hash')) {
    d.exec('ALTER TABLE oauth_sessions ADD COLUMN prev_refresh_hash TEXT');
  }
}

/** Test hook: point the store at a throwaway in-memory DB. */
export function openTestStore(): void {
  const { DatabaseSync } = loadSqlite();
  db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
}

const now = () => Date.now();

// ------------------------------------------------------------------ clients ---

export function insertClient(c: ClientRow): void {
  getDb()
    .prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
    .run(c.id, c.name, JSON.stringify(c.redirectUris), c.createdAt);
}

export function getClient(id: string): ClientRow | undefined {
  const r = getDb().prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id);
  if (!r) return undefined;
  return {
    id: String(r.id),
    name: String(r.name),
    redirectUris: JSON.parse(String(r.redirect_uris)) as string[],
    createdAt: Number(r.created_at),
  };
}

// -------------------------------------------------------------------- codes ---

export function insertCode(c: CodeRow): void {
  getDb()
    .prepare(
      'INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, challenge, enc_jwt, user_label, user_email, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(c.codeHash, c.clientId, c.redirectUri, c.challenge, c.encJwt, c.userLabel, c.userEmail, c.expiresAt);
}

/** Fetch AND delete (single use). Returns undefined for unknown or expired codes. */
export function consumeCode(codeHash: string): CodeRow | undefined {
  const d = getDb();
  const r = d.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash);
  d.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(codeHash);
  // Opportunistic cleanup of other expired codes (table stays tiny).
  d.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now());
  if (!r || Number(r.expires_at) < now()) return undefined;
  return {
    codeHash: String(r.code_hash),
    clientId: String(r.client_id),
    redirectUri: String(r.redirect_uri),
    challenge: String(r.challenge),
    encJwt: String(r.enc_jwt),
    userLabel: String(r.user_label),
    userEmail: String(r.user_email),
    expiresAt: Number(r.expires_at),
  };
}

// ----------------------------------------------------------------- sessions ---

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    id: String(r.id),
    accessHash: String(r.access_hash),
    refreshHash: String(r.refresh_hash),
    clientId: String(r.client_id),
    clientName: String(r.client_name),
    userLabel: String(r.user_label),
    userEmail: String(r.user_email),
    encJwt: String(r.enc_jwt),
    accessExpiresAt: Number(r.access_expires_at),
    createdAt: Number(r.created_at),
    lastUsedAt: Number(r.last_used_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
  };
}

/** Retention: revoked sessions keep 7 days (visible history on /me), idle
 *  sessions die after the wiki's 14d renewal window anyway — purge at 28d. */
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IDLE_RETENTION_MS = 28 * 24 * 60 * 60 * 1000;

/** Delete dead session rows. Called opportunistically on session creation. */
export function cleanupSessions(at: number = now()): void {
  getDb()
    .prepare('DELETE FROM oauth_sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR last_used_at < ?')
    .run(at - REVOKED_RETENTION_MS, at - IDLE_RETENTION_MS);
}

export function insertSession(s: SessionRow): void {
  cleanupSessions();
  getDb()
    .prepare(
      `INSERT INTO oauth_sessions
       (id, access_hash, refresh_hash, client_id, client_name, user_label, user_email, enc_jwt, access_expires_at, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.id, s.accessHash, s.refreshHash, s.clientId, s.clientName, s.userLabel, s.userEmail,
      s.encJwt, s.accessExpiresAt, s.createdAt, s.lastUsedAt, s.revokedAt,
    );
}

export function getSessionByAccessHash(hash: string): SessionRow | undefined {
  const r = getDb().prepare('SELECT * FROM oauth_sessions WHERE access_hash = ?').get(hash);
  return r ? rowToSession(r) : undefined;
}

export function getSessionByRefreshHash(hash: string): SessionRow | undefined {
  const r = getDb().prepare('SELECT * FROM oauth_sessions WHERE refresh_hash = ?').get(hash);
  return r ? rowToSession(r) : undefined;
}

export function getSessionById(id: string): SessionRow | undefined {
  const r = getDb().prepare('SELECT * FROM oauth_sessions WHERE id = ?').get(id);
  return r ? rowToSession(r) : undefined;
}

/** Rotate access+refresh hashes on a refresh grant. The previous refresh hash is
 *  kept for ONE generation so a replay of it can be detected as token theft. */
export function rotateSessionTokens(id: string, accessHash: string, refreshHash: string, accessExpiresAt: number): void {
  getDb()
    .prepare(
      'UPDATE oauth_sessions SET prev_refresh_hash = refresh_hash, access_hash = ?, refresh_hash = ?, access_expires_at = ? WHERE id = ?',
    )
    .run(accessHash, refreshHash, accessExpiresAt, id);
}

/** Lookup by an ALREADY-ROTATED refresh hash (reuse = theft signal). */
export function getSessionByPrevRefreshHash(hash: string): SessionRow | undefined {
  const r = getDb().prepare('SELECT * FROM oauth_sessions WHERE prev_refresh_hash = ?').get(hash);
  return r ? rowToSession(r) : undefined;
}

/** Persist a renewed Wiki.js JWT (captured from the `new-jwt` response header). */
export function updateSessionJwt(id: string, encJwt: string): void {
  getDb().prepare('UPDATE oauth_sessions SET enc_jwt = ? WHERE id = ?').run(encJwt, id);
}

export function touchSession(id: string, at: number = now()): void {
  getDb().prepare('UPDATE oauth_sessions SET last_used_at = ? WHERE id = ?').run(at, id);
}

export function revokeSession(id: string): void {
  getDb().prepare('UPDATE oauth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id);
}

/** All sessions of one wiki user (for the /me page), newest first. */
export function listSessionsByEmail(email: string): SessionRow[] {
  return getDb()
    .prepare('SELECT * FROM oauth_sessions WHERE user_email = ? ORDER BY created_at DESC')
    .all(email)
    .map(rowToSession);
}

/** Every ACTIVE session across all users (admin view on /me). */
export function listActiveSessions(): SessionRow[] {
  return getDb()
    .prepare('SELECT * FROM oauth_sessions WHERE revoked_at IS NULL ORDER BY last_used_at DESC')
    .all()
    .map(rowToSession);
}

// -------------------------------------------------------------------- audit ---

export function insertAudit(a: AuditRow): void {
  getDb()
    .prepare('INSERT INTO audit_log (ts, session_id, profile, tool, category, outcome, ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(a.ts, a.sessionId, a.profile, a.tool, a.category, a.outcome, a.ms);
}

/** Most recent audit entries (admin view on /me), newest first. */
export function listAudit(limit: number): AuditRow[] {
  return getDb()
    .prepare('SELECT ts, session_id, profile, tool, category, outcome, ms FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({
      ts: Number(r.ts),
      sessionId: r.session_id == null ? null : String(r.session_id),
      profile: r.profile == null ? null : String(r.profile),
      tool: String(r.tool),
      category: String(r.category),
      outcome: String(r.outcome),
      ms: Number(r.ms),
    }));
}
