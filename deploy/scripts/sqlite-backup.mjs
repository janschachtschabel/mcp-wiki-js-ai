#!/usr/bin/env node
/**
 * Backup of the MCP server's SQLite store (OAuth clients and sessions, audit log)
 * for the Compose stacks. Runs as its own small service from the MCP image — as
 * the unprivileged node user and without network, so nothing is installed at
 * start (audit A-50). VACUUM INTO writes a consistent copy while the server keeps
 * writing (WAL); a copy is only renamed into place once complete (A-16).
 *
 * Env: MCP_DB                   store file (default /data/mcp.sqlite)
 *      BACKUP_DIR               target directory (default /backups)
 *      BACKUP_INTERVAL_SECONDS  pause between runs (default 86400, min 60)
 *      BACKUP_KEEP              copies kept (default 7)
 *      BACKUP_ONCE=1            one run, then exit (tests, manual runs)
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB = process.env.MCP_DB || '/data/mcp.sqlite';
const DIR = process.env.BACKUP_DIR || '/backups';
const intEnv = (name, def, min) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min ? n : def;
};
const INTERVAL_S = intEnv('BACKUP_INTERVAL_SECONDS', 86_400, 60);
const KEEP = intEnv('BACKUP_KEEP', 7, 1);
const COPY = /^mcp-\d{8}-\d{6}\.sqlite$/;

/** 20261023-142501 (UTC) — sorts by time as a string. */
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function backupOnce() {
  // Leftovers of an interrupted run never count as a backup.
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.part')) fs.rmSync(path.join(DIR, f), { force: true });
  if (!fs.existsSync(DB)) {
    console.log(`no MCP store yet (${DB}) — nothing to back up`);
    return true;
  }
  const name = `mcp-${stamp()}.sqlite`;
  const part = path.join(DIR, `.${name}.part`);
  const db = new DatabaseSync(DB);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec(`VACUUM INTO '${part.replaceAll("'", "''")}'`);
  } catch (e) {
    fs.rmSync(part, { force: true });
    console.error(`backup FAILED (mcp sqlite): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    db.close();
  }
  fs.renameSync(part, path.join(DIR, name));
  console.log(`backup ok: ${name}`);
  const old = fs.readdirSync(DIR).filter((f) => COPY.test(f)).sort().reverse().slice(KEEP);
  for (const f of old) fs.rmSync(path.join(DIR, f));
  return true;
}

if (process.env.BACKUP_ONCE === '1') {
  process.exit(backupOnce() ? 0 : 1);
}
for (;;) {
  backupOnce();
  await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
}
