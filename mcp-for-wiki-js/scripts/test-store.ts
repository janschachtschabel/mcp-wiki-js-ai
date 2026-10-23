/**
 * Offline tests for the sqlite store's schema care (audit R-41 to R-44):
 * versioned migrations (PRAGMA user_version), opening a store created by an
 * older version, busy_timeout, indexes, the atomic code consumption and the
 * compare-and-swap refresh rotation. Uses a throwaway file DB in the OS temp
 * directory (a legacy store must exist on disk BEFORE the store opens it).
 * Run: npm run test:store
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

process.env.MCP_SESSION_SECRET = 'test-secret-for-store-suite-0123456789';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log('ok  -', name);
  } else {
    failed++;
    console.log('FAIL-', name);
  }
}

/** The schema as shipped BEFORE versioned migrations (no prev_refresh_hash, no user_id). */
const LEGACY_SCHEMA = `
CREATE TABLE oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
  enc_jwt TEXT NOT NULL, user_label TEXT NOT NULL, user_email TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE oauth_sessions (id TEXT PRIMARY KEY, access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL, client_name TEXT NOT NULL, user_label TEXT NOT NULL, user_email TEXT NOT NULL, enc_jwt TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT, profile TEXT,
  tool TEXT NOT NULL, category TEXT NOT NULL, outcome TEXT NOT NULL, ms INTEGER NOT NULL);
`;

async function main(): Promise<void> {
  const store = await import('../lib/oauth/store');
  const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
    DatabaseSync: { prototype: unknown } & (new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown }; close(): void });
  };

  const dir = mkdtempSync(join(tmpdir(), 'mcp-store-test-'));
  const file = join(dir, 'legacy.sqlite');
  try {
    // ---- a store written by an older version --------------------------------
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY_SCHEMA);
    const now = Date.now();
    legacy
      .prepare(
        'INSERT INTO oauth_sessions (id, access_hash, refresh_hash, client_id, client_name, user_label, user_email, enc_jwt, access_expires_at, created_at, last_used_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)',
      )
      .run('legacy-session', 'la', 'lr', 'c1', 'Old client', 'Alice', 'alice@example.org', 'enc', now + 3600_000, now, now);
    legacy.close();

    store.openTestStore(file);
    check('R-44: legacy store is migrated to the latest user_version', store.dbPragma('user_version') === store.SCHEMA_VERSION);
    check('R-44: SCHEMA_VERSION is at least 1 (versioned migrations exist)', store.SCHEMA_VERSION >= 1);
    const old = store.getSessionById('legacy-session');
    check('R-44: legacy session row is still readable after migration', old?.userLabel === 'Alice');
    check('R-41: legacy rows carry no wiki user id (NULL, not 0)', old !== undefined && old.userId === null);
    check('A-39: the migration revokes sessions without a wiki user id', old !== undefined && old.revokedAt !== null);
    check('A-38/A-39: … and drops their encrypted wiki JWT', old !== undefined && old.encJwt === '');
    check(
      'R-41: a legacy row without user id is still listed for its email owner',
      store.listSessionsForUser(7, 'alice@example.org').some((s) => s.id === 'legacy-session'),
    );

    // New columns are usable on the migrated store.
    store.insertSession({
      id: 'new-session', accessHash: 'na', refreshHash: 'nr', clientId: 'c1', clientName: 'New client',
      userLabel: 'Alice', userEmail: 'alice@example.org', userId: 7, encJwt: 'enc',
      accessExpiresAt: now + 3600_000, createdAt: now, lastUsedAt: now, revokedAt: null,
    });
    check('R-41: user id is persisted', store.getSessionById('new-session')?.userId === 7);
    check(
      'R-41: listing is by wiki user id — another account with the SAME email does not see it',
      !store.listSessionsForUser(8, 'alice@example.org').some((s) => s.id === 'new-session'),
    );
    check(
      'R-41: the owning user id sees it',
      store.listSessionsForUser(7, 'alice@example.org').some((s) => s.id === 'new-session'),
    );

    // Re-opening an already migrated store is a no-op (idempotent).
    store.closeStore();
    store.openTestStore(file);
    check('R-44: re-open keeps the version and the data', store.dbPragma('user_version') === store.SCHEMA_VERSION && store.getSessionById('new-session')?.userId === 7);

    // ---- R-43 / R-44 pragmas and indexes ------------------------------------
    check('R-43: busy_timeout is set (backup sidecar holds the DB briefly)', Number(store.dbPragma('busy_timeout')) >= 5000);
    const indexes = store.indexNames();
    check('R-44: index on audit_log(ts) exists', indexes.includes('idx_audit_ts'));
    check('R-44: index on oauth_sessions(last_used_at) exists', indexes.includes('idx_sessions_last_used'));
    check('R-41: index on oauth_sessions(user_id) exists', indexes.includes('idx_sessions_user_id'));
    check('A-25: index on oauth_sessions(client_id) exists', indexes.includes('idx_sessions_client_id'));
    check('A-25: index on oauth_codes(client_id) exists', indexes.includes('idx_codes_client_id'));

    // ---- A-38: revoking drops the encrypted wiki JWT -------------------------
    store.insertSession({
      id: 'to-revoke', accessHash: 'ra', refreshHash: 'rr', clientId: 'c1', clientName: 'C',
      userLabel: 'Bob', userEmail: 'bob@example.org', userId: 9, encJwt: 'secret-jwt-ciphertext',
      accessExpiresAt: now + 3600_000, createdAt: now, lastUsedAt: now, revokedAt: null,
    });
    store.revokeSession('to-revoke');
    const revoked = store.getSessionById('to-revoke');
    check('A-38: a revoked session keeps no encrypted wiki JWT', revoked?.revokedAt != null && revoked.encJwt === '');

    // ---- A-25: expired codes are cleaned up on insert, not only on redemption --
    store.insertCode({
      codeHash: 'stale-code', clientId: 'c1', redirectUri: 'https://x.example/cb', challenge: 'ch', encJwt: 'enc',
      userLabel: 'Alice', userEmail: 'alice@example.org', userId: 7, expiresAt: now - 2 * 3600_000,
    });
    store.insertCode({
      codeHash: 'fresh-code', clientId: 'c1', redirectUri: 'https://x.example/cb', challenge: 'ch', encJwt: 'enc',
      userLabel: 'Alice', userEmail: 'alice@example.org', userId: 7, expiresAt: now + 60_000,
    });
    check('A-25: inserting a code removes long-expired ones', store.codeExists('stale-code') === false && store.codeExists('fresh-code'));

    // ---- R-42: atomic single use + CAS rotation ------------------------------
    store.insertCode({
      codeHash: 'code-1', clientId: 'c1', redirectUri: 'https://x.example/cb', challenge: 'ch', encJwt: 'enc',
      userLabel: 'Alice', userEmail: 'alice@example.org', userId: 7, expiresAt: now + 60_000,
    });
    const first = store.consumeCode('code-1');
    check('R-42: first consumption returns the code (incl. user id)', first?.userId === 7);
    check('R-42: second consumption returns nothing', store.consumeCode('code-1') === undefined);
    check('R-25: a consumed code leaves a tombstone (reuse is detectable)', store.consumedCodeSession('code-1') !== undefined);
    store.linkCodeToSession('code-1', 'new-session');
    check('R-25: the tombstone names the session issued from the code', store.consumedCodeSession('code-1')?.sessionId === 'new-session');
    check('R-25: unknown codes have no tombstone', store.consumedCodeSession('never-issued') === undefined);

    check('R-42: rotation with the current refresh hash succeeds', store.rotateSessionTokens('new-session', 'nr', 'na2', 'nr2', now + 3600_000));
    check(
      'R-42: rotation with a stale refresh hash (another process won) is refused',
      !store.rotateSessionTokens('new-session', 'nr', 'na3', 'nr3', now + 3600_000) && store.getSessionById('new-session')?.refreshHash === 'nr2',
    );
    check('R-42: the refused rotation left the winner\'s previous hash intact', store.getSessionByPrevRefreshHash('nr')?.id === 'new-session');

    check('R-39: ping succeeds on a healthy store', store.ping());
  } finally {
    store.closeStore();
    rmSync(dir, { recursive: true, force: true });
  }

  // A fresh in-memory test store runs the same migrations (R-44: openTestStore used to skip them).
  store.openTestStore();
  check('R-44: openTestStore runs the migrations too', store.dbPragma('user_version') === store.SCHEMA_VERSION);
  store.closeStore();

  // A file that is no sqlite DB makes prepareSchema throw: the handle opened for it
  // must be closed, not leaked (each getDb() retry would otherwise open another one).
  const proto = DatabaseSync.prototype as { close(): void };
  const realClose = proto.close;
  let closes = 0;
  proto.close = function (this: unknown) {
    closes++;
    return realClose.call(this);
  };
  const badDir = mkdtempSync(join(tmpdir(), 'mcp-store-bad-'));
  const badFile = join(badDir, 'not-a-db.sqlite');
  writeFileSync(badFile, 'this is not a sqlite database '.repeat(200));
  let threw = false;
  try {
    store.openTestStore(badFile);
  } catch {
    threw = true;
  } finally {
    proto.close = realClose;
  }
  check('openDatabase: a broken store file is reported (prepareSchema throws)', threw);
  check('openDatabase: … and the handle opened for it is closed again', closes === 1);
  store.closeStore();
  rmSync(badDir, { recursive: true, force: true });

  if (failed === 0) {
    console.log(`\n${pass} store assertions passed.`);
  } else {
    console.error(`\n${failed} store assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
