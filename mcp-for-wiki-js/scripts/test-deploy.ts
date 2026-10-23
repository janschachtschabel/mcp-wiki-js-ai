/**
 * Offline tests for the deploy scripts in deploy/scripts (run as child processes
 * against temp directories, no Docker):
 *  - standalone-init.mjs: the MCP session secret lives in its own volume that
 *    Wiki.js never mounts, an existing secret is moved there unchanged (A-14);
 *    a DOMAIN with a port is refused for the Traefik variant (A-43)
 *  - sqlite-backup.mjs: consistent copy of the MCP store, rotation, no partial
 *    files (A-16, A-50)
 *  - the MCP path list is the same in every routing file (A-30)
 * Run: npm run test:deploy
 */
export {}; // module scope — keeps `pass`/`failed` from colliding with the other test scripts

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INIT = path.join(ROOT, 'deploy', 'scripts', 'standalone-init.mjs');
const BACKUP = path.join(ROOT, 'deploy', 'scripts', 'sqlite-backup.mjs');
const TEMPLATE = path.join(ROOT, 'deploy', 'caddy', 'Caddyfile');

function run(script: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script], { env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', ...env }, timeout: 30_000 }, (err: Error | null, stdout: string, stderr: string) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    );
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined);

async function initTests(): Promise<void> {
  // A-14: with MCP_SECRETS_DIR the session secret goes there, not into the shared volume.
  let stack = tmp();
  const initEnv = (dir: string, extra: Record<string, string> = {}) => ({
    STACK_DIR: dir,
    CADDY_TEMPLATE: TEMPLATE,
    MCP_SECRETS_DIR: path.join(dir, 'mcp-secrets'),
    DOMAIN: 'wiki.example.org',
    ...extra,
  });
  let r = await run(INIT, initEnv(stack));
  check(`A-14: init succeeds with a separate MCP secrets dir (exit ${r.code})`, r.code === 0);
  check('A-14: session.env is written to the MCP-only volume', /^MCP_SESSION_SECRET=.{40,}\n$/.test(read(path.join(stack, 'mcp-secrets', 'session.env')) ?? ''));
  check('A-14: the shared volume (mounted by Wiki.js) holds no session secret', !fs.existsSync(path.join(stack, 'secrets', 'session.env')));
  check('init: the shared volume still holds the DB password and public.env', fs.existsSync(path.join(stack, 'secrets', 'postgres_password')) && /PUBLIC_BASE_URL=https:\/\/wiki\.example\.org/.test(read(path.join(stack, 'secrets', 'public.env')) ?? ''));

  // A-14: an existing installation keeps its secret (sessions stay valid) — moved, not regenerated.
  stack = tmp();
  fs.mkdirSync(path.join(stack, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(stack, 'secrets', 'session.env'), 'MCP_SESSION_SECRET=existing-secret-value-0123456789abcdef\n');
  r = await run(INIT, initEnv(stack));
  check('A-14: an existing secret is moved unchanged to the MCP-only volume', r.code === 0 && read(path.join(stack, 'mcp-secrets', 'session.env')) === 'MCP_SESSION_SECRET=existing-secret-value-0123456789abcdef\n');
  check('A-14: … and removed from the shared volume', !fs.existsSync(path.join(stack, 'secrets', 'session.env')));
  const before = read(path.join(stack, 'mcp-secrets', 'session.env'));
  r = await run(INIT, initEnv(stack));
  check('A-14: later starts keep the moved secret', r.code === 0 && read(path.join(stack, 'mcp-secrets', 'session.env')) === before);

  // Older compose files (no MCP_SECRETS_DIR) keep the previous layout — no silent move into a non-volume path.
  stack = tmp();
  r = await run(INIT, { STACK_DIR: stack, CADDY_TEMPLATE: TEMPLATE, DOMAIN: 'wiki.example.org' });
  check('init without MCP_SECRETS_DIR keeps session.env in the shared volume (old compose files)', r.code === 0 && fs.existsSync(path.join(stack, 'secrets', 'session.env')));

  // A-43: Traefik routes by host name only — a port in DOMAIN would leave the site without a route.
  for (const domain of ['wiki.example.org:8443', 'wiki.example.org:80', ':80']) {
    r = await run(INIT, initEnv(tmp(), { DOMAIN: domain, INIT_ROUTER: 'traefik' }));
    check(`A-43: Traefik variant refuses DOMAIN="${domain}"`, r.code !== 0 && /Port/.test(r.out));
  }
  r = await run(INIT, initEnv(tmp(), { DOMAIN: 'wiki.example.org', INIT_ROUTER: 'traefik' }));
  check('A-43: Traefik variant accepts a plain host name', r.code === 0);
  r = await run(INIT, initEnv(tmp(), { DOMAIN: 'wiki.example.org:8443' }));
  check('A-43: the Caddy variant still accepts a port', r.code === 0);
}

async function backupTests(): Promise<void> {
  const data = tmp();
  const backups = tmp();
  const dbFile = path.join(data, 'mcp.sqlite');
  const live = new DatabaseSync(dbFile);
  live.exec("PRAGMA journal_mode = WAL; CREATE TABLE audit_log (id INTEGER PRIMARY KEY, tool TEXT); INSERT INTO audit_log (tool) VALUES ('wiki_page_update');");
  // Two older copies, one stale partial file from an interrupted run.
  fs.writeFileSync(path.join(backups, 'mcp-20200101-000000.sqlite'), 'old');
  fs.writeFileSync(path.join(backups, 'mcp-20200102-000000.sqlite'), 'old');
  fs.writeFileSync(path.join(backups, '.mcp-20200103-000000.sqlite.part'), 'partial');
  const env = { MCP_DB: dbFile, BACKUP_DIR: backups, BACKUP_ONCE: '1', BACKUP_KEEP: '2' };
  const r = await run(BACKUP, env);
  live.close();
  const files = fs.readdirSync(backups).sort();
  const fresh = files.find((f) => /^mcp-\d{8}-\d{6}\.sqlite$/.test(f) && !f.startsWith('mcp-2020'));
  check(`A-50: sqlite-backup writes a copy while the store is open (exit ${r.code})`, r.code === 0 && fresh !== undefined);
  if (fresh) {
    const copy = new DatabaseSync(path.join(backups, fresh), { readOnly: true });
    const row = copy.prepare('SELECT tool FROM audit_log').get() as { tool?: string } | undefined;
    copy.close();
    check('A-50: the copy is a complete SQLite database', row?.tool === 'wiki_page_update');
  }
  check('A-16: rotation keeps the newest BACKUP_KEEP copies', files.filter((f) => f.endsWith('.sqlite')).length === 2 && !files.includes('mcp-20200101-000000.sqlite'));
  check('A-16: stale partial files are removed', !files.some((f) => f.endsWith('.part')));

  // Review: an unreadable store is reported, not an uncaught crash (a crash-looping
  // Helm sidecar would mark the MCP pod NotReady).
  const broken = await run(BACKUP, { ...env, MCP_DB: tmp() });
  check('review: an unreadable store is reported as "backup FAILED", not a stack trace', broken.code !== 0 && /backup FAILED/.test(broken.out) && !/\n\s+at /.test(broken.out));

  const none = await run(BACKUP, { ...env, MCP_DB: path.join(tmp(), 'missing.sqlite') });
  check('A-50: no store yet → nothing to back up, no error', none.code === 0 && /nothing to back up/i.test(none.out));
}

// ---- A-30: one MCP path list, six places ------------------------------------------
type Route = string; // "exact /me" | "prefix /me/"

const sorted = (xs: Iterable<Route>) => [...new Set(xs)].sort();

/** Traefik rule: Path(`/x`) → exact, PathPrefix(`/x`) → prefix. */
function traefikRoutes(rule: string): Route[] {
  return [...rule.matchAll(/(PathPrefix|Path)\(`([^`]+)`\)/g)].map((m) => `${m[1] === 'Path' ? 'exact' : 'prefix'} ${m[2]}`);
}

/** The MCP router rule of a compose file (the label …<router>.rule=Host(…) && (…)). */
function composeRoutes(file: string, router: RegExp): Route[] {
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => router.test(l) && l.includes('.rule='));
  if (!line) throw new Error(`no MCP router rule in ${file}`);
  return traefikRoutes(line);
}

/** Caddy @mcp matcher: "/x" exact, "/x/*" prefix "/x/", "/x*" prefix "/x". */
function caddyRoutes(file: string): Route[] {
  const block = /@mcp \{([\s\S]*?)\n\t\}/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
  return block
    .split('\n')
    .filter((l) => l.trim().startsWith('path '))
    .flatMap((l) => l.trim().slice(5).split(/\s+/))
    .map((p) => (p.endsWith('*') ? `prefix ${p.slice(0, -1)}` : `exact ${p}`));
}

/** Helm values: "- { path: /x, pathType: Exact|Prefix }" under the given key. */
function helmRoutes(file: string, key: string): Route[] {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(`  ${key}:\n`);
  if (start < 0) throw new Error(`no ${key} in ${file}`);
  const routes: Route[] = [];
  for (const line of text.slice(start).split('\n').slice(1)) {
    const m = /^\s*- \{ path: (\S+), pathType: (Exact|Prefix) \}/.exec(line);
    if (!m) break;
    routes.push(`${m[2] === 'Exact' ? 'exact' : 'prefix'} ${m[1]}`);
  }
  return routes;
}

function pathTests(): void {
  const canonical = sorted(composeRoutes(path.join(ROOT, 'docker-compose.yml'), /routers\.\$\{INSTANCE:-wikijs\}-mcp\.rule/));
  check(`A-30: the root compose file names the MCP paths (${canonical.length})`, canonical.length >= 10 && canonical.includes('exact /mcp'));
  const sources: Array<[string, Route[]]> = [
    ['deploy/standalone/mcp-only/docker-compose.yml', composeRoutes(path.join(ROOT, 'deploy/standalone/mcp-only/docker-compose.yml'), /routers\.\$\{INSTANCE:-wikijs-mcponly\}\.rule/)],
    ['deploy/caddy/Caddyfile', caddyRoutes(path.join(ROOT, 'deploy/caddy/Caddyfile'))],
    ['deploy/helm/wikijs-stack/values.yaml', helmRoutes(path.join(ROOT, 'deploy/helm/wikijs-stack/values.yaml'), 'mcpPaths')],
    ['deploy/helm/wikijs-mcp/values.yaml', helmRoutes(path.join(ROOT, 'deploy/helm/wikijs-mcp/values.yaml'), 'paths')],
  ];
  for (const [name, routes] of sources) {
    const got = sorted(routes);
    const missing = canonical.filter((r) => !got.includes(r));
    const extra = got.filter((r) => !canonical.includes(r));
    check(`A-30: ${name} routes the same MCP paths${missing.length || extra.length ? ` (missing: ${missing.join(', ') || '-'}; extra: ${extra.join(', ') || '-'})` : ''}`, missing.length === 0 && extra.length === 0);
  }
  // The comparison itself must notice a drift.
  check('A-30: a missing path is detected', sorted(traefikRoutes('Path(`/mcp`) || PathPrefix(`/oauth/`)')).join() !== canonical.join());
}

async function main(): Promise<void> {
  await initTests();
  await backupTests();
  pathTests();
  if (failed === 0) {
    console.log(`\n${pass} deploy assertions passed.`);
  } else {
    console.error(`\n${failed} deploy assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
