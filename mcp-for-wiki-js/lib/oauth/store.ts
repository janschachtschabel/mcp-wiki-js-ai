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
import { oauthEnabled } from './crypto';
import { prepareSchema, SCHEMA_VERSION, type SqliteDatabase } from './schema';

// Re-exported: the routes import it from here; it lives in crypto.ts so callers
// that must not load node:sqlite (lib/register.ts, stdio) can use it too.
export { oauthEnabled, SCHEMA_VERSION };

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
  /** Wiki.js user id — the stable identity (emails are unique only per auth provider, R-41). */
  userId: number | null;
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
  /** null on rows written before R-41 (they fall back to email ownership until they expire). */
  userId: number | null;
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

/** Open a DB file (or ':memory:') with the pragmas and the latest schema. */
function openDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = loadSqlite();
  const d = new DatabaseSync(path);
  try {
    prepareSchema(d);
  } catch (e) {
    d.close(); // otherwise every getDb() retry leaks another handle (and Windows keeps the file locked)
    throw e;
  }
  return d;
}

/** Lazy singleton — opened on first use, shared per process. */
function getDb(): SqliteDatabase {
  if (db) return db;
  if (!oauthEnabled()) throw new Error('OAuth store unavailable: MCP_SESSION_SECRET is not set.');
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  db = openDatabase(join(dir, 'mcp.sqlite'));
  return db;
}

/** Test hook: point the store at a throwaway DB (in-memory by default), fully migrated. */
export function openTestStore(path = ':memory:'): void {
  closeStore();
  db = openDatabase(path);
}

/** Test hook: release the DB handle (Windows keeps an open file locked). */
export function closeStore(): void {
  db?.close();
  db = null;
}

/** Test hook: one pragma value (the name is a fixed identifier, never input). */
export function dbPragma(name: string): unknown {
  if (!/^[a-z_]+$/.test(name)) throw new Error('invalid pragma name');
  const row = getDb().prepare(`PRAGMA ${name}`).get();
  return row ? Object.values(row)[0] : undefined;
}

/** Test hook: whether a code row (live or tombstone) is still stored. */
export function codeExists(codeHash: string): boolean {
  return getDb().prepare('SELECT 1 FROM oauth_codes WHERE code_hash = ?').get(codeHash) !== undefined;
}

/** Test hook: names of all indexes in the store. */
export function indexNames(): string[] {
  return getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((r) => String(r.name));
}

/** Health probe (R-39): the store opens and answers a trivial query. */
export function ping(): boolean {
  return getDb().prepare('SELECT 1 AS ok').get()?.ok === 1;
}

const now = () => Date.now();

// ------------------------------------------------------------------ clients ---

export function insertClient(c: ClientRow): void {
  cleanupSessions(); // open DCR: keep the client table bounded without a background job
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
  const d = getDb();
  // Unredeemed codes would otherwise linger until the next redemption (A-25).
  d.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now() - CODE_TOMBSTONE_MS);
  d
    .prepare(
      'INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, challenge, enc_jwt, user_label, user_email, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(c.codeHash, c.clientId, c.redirectUri, c.challenge, c.encJwt, c.userLabel, c.userEmail, c.userId, c.expiresAt);
}

/** Consumed codes stay as tombstones this long past their expiry, so a replay
 *  can still be traced to the session it produced (R-25). */
const CODE_TOMBSTONE_MS = 60 * 60 * 1000;

/**
 * Mark a code consumed and return it (single use). One UPDATE … RETURNING, so
 * two processes cannot both redeem it (R-42). Undefined for unknown, already
 * used or expired codes.
 */
export function consumeCode(codeHash: string): CodeRow | undefined {
  const d = getDb();
  const r = d
    .prepare('UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL RETURNING *')
    .get(now(), codeHash);
  // Opportunistic cleanup of old codes and tombstones (table stays tiny).
  d.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now() - CODE_TOMBSTONE_MS);
  if (!r || Number(r.expires_at) < now()) return undefined;
  return {
    codeHash: String(r.code_hash),
    clientId: String(r.client_id),
    redirectUri: String(r.redirect_uri),
    challenge: String(r.challenge),
    encJwt: String(r.enc_jwt),
    userLabel: String(r.user_label),
    userEmail: String(r.user_email),
    userId: r.user_id == null ? null : Number(r.user_id),
    expiresAt: Number(r.expires_at),
  };
}

/** Remember which session a code produced (for reuse revocation, R-25). */
export function linkCodeToSession(codeHash: string, sessionId: string): void {
  getDb().prepare('UPDATE oauth_codes SET session_id = ? WHERE code_hash = ?').run(sessionId, codeHash);
}

/** A code that was ALREADY consumed (reuse signal), with the session it produced. */
export function consumedCodeSession(codeHash: string): { sessionId: string | null } | undefined {
  const r = getDb()
    .prepare('SELECT session_id FROM oauth_codes WHERE code_hash = ? AND consumed_at IS NOT NULL')
    .get(codeHash);
  return r ? { sessionId: r.session_id == null ? null : String(r.session_id) } : undefined;
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
    userId: r.user_id == null ? null : Number(r.user_id),
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
/** Audit rows are the persisted accountability trail; keep them longer than sessions. */
const AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
/** A registered client with no session or code left is dead weight after a day
 *  (authorization takes minutes; MCP clients re-register on invalid_client). */
const UNUSED_CLIENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Delete dead session rows, unused clients and aged-out audit entries. Called
 *  opportunistically on session/client creation, so the store stays bounded
 *  without a background job. */
export function cleanupSessions(at: number = now()): void {
  const d = getDb();
  d.prepare('DELETE FROM oauth_sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR last_used_at < ?').run(
    at - REVOKED_RETENTION_MS,
    at - IDLE_RETENTION_MS,
  );
  d.prepare('DELETE FROM audit_log WHERE ts < ?').run(at - AUDIT_RETENTION_MS);
  d.prepare(
    `DELETE FROM oauth_clients WHERE created_at < ?
       AND NOT EXISTS (SELECT 1 FROM oauth_sessions s WHERE s.client_id = oauth_clients.id)
       AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.client_id = oauth_clients.id)`,
  ).run(at - UNUSED_CLIENT_RETENTION_MS);
}

export function insertSession(s: SessionRow): void {
  getDb()
    .prepare(
      `INSERT INTO oauth_sessions
       (id, access_hash, refresh_hash, client_id, client_name, user_label, user_email, user_id, enc_jwt, access_expires_at, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.id, s.accessHash, s.refreshHash, s.clientId, s.clientName, s.userLabel, s.userEmail, s.userId,
      s.encJwt, s.accessExpiresAt, s.createdAt, s.lastUsedAt, s.revokedAt,
    );
  // AFTER the insert: the code was already consumed, so before it the client
  // would briefly look unused and be purged.
  cleanupSessions();
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
 *  kept for ONE generation so a replay of it can be detected as token theft.
 *  Compare-and-swap on the presented refresh hash: false when another request
 *  (or process) rotated first (R-42). */
export function rotateSessionTokens(
  id: string,
  expectedRefreshHash: string,
  accessHash: string,
  refreshHash: string,
  accessExpiresAt: number,
): boolean {
  const res = getDb()
    .prepare(
      'UPDATE oauth_sessions SET prev_refresh_hash = refresh_hash, access_hash = ?, refresh_hash = ?, access_expires_at = ? WHERE id = ? AND refresh_hash = ?',
    )
    .run(accessHash, refreshHash, accessExpiresAt, id, expectedRefreshHash);
  return Number(res.changes) === 1;
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

/** Revoke and drop the encrypted wiki JWT: a later DB + secret leak yields nothing for it (A-38). */
export function revokeSession(id: string): void {
  getDb().prepare("UPDATE oauth_sessions SET revoked_at = ?, enc_jwt = '' WHERE id = ? AND revoked_at IS NULL").run(now(), id);
}

/**
 * All sessions of one wiki user (for the /me page), newest first. Owned by the
 * wiki user id; rows from before R-41 (no id yet) fall back to the email.
 */
export function listSessionsForUser(userId: number, email: string): SessionRow[] {
  return getDb()
    .prepare('SELECT * FROM oauth_sessions WHERE user_id = ? OR (user_id IS NULL AND user_email = ?) ORDER BY created_at DESC')
    .all(userId, email)
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
