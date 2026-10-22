#!/usr/bin/env node
/**
 * Init-Schritt für deploy/standalone/full/docker-compose.yml — läuft bei jedem
 * Start vor Postgres, Wiki.js, MCP und Caddy und beendet sich dann.
 *
 *   1. Geheimnisse beim ERSTEN Start zufällig erzeugen und im Volume behalten
 *      (Postgres-Passwort, MCP_SESSION_SECRET). Dadurch braucht die Compose-
 *      Datei keine Pflicht-Variablen: Docker-Panels, die erst nach einer
 *      erfolgreichen Bereitstellung Variablen erlauben, können sie starten.
 *   2. Öffentliche Adresse aus DOMAIN ableiten (PUBLIC_BASE_URL / PUBLIC_URL)
 *      und als env-Datei für MCP-Server und Bootstrap ablegen.
 *   3. Caddyfile aus der Vorlage im Image schreiben: mit DOMAIN das normale
 *      Routing, ohne DOMAIN eine Hinweisseite „noch nicht eingerichtet“.
 *
 * Env: DOMAIN       Hostname (wiki.example.org) oder Adresse für reines HTTP
 *                   (:80, z. B. hinter einem weiteren Proxy oder zum Testen).
 *      STACK_DIR    Basis der Volumes (Default /stack).
 *      CADDY_TEMPLATE  Vorlage (Default /app/Caddyfile = deploy/caddy/Caddyfile).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STACK_DIR = process.env.STACK_DIR || '/stack';
const SECRETS = path.join(STACK_DIR, 'secrets');
const CADDY_DIR = path.join(STACK_DIR, 'caddy');
const TEMPLATE = process.env.CADDY_TEMPLATE || '/app/Caddyfile';
const PLACEHOLDER = '{$DOMAIN:localhost}';

const log = (msg) => console.log('•', msg);

/** Write via temp file + rename, so a reader (caddy --watch) never sees half a file. */
function writeAtomic(file, content, mode) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

/** Create a secret file once; later starts keep it (the database is initialised with it). */
function ensureSecret(file, content, mode) {
  if (fs.existsSync(file)) return false;
  writeAtomic(file, content, mode);
  return true;
}

/** Accept "wiki.example.org", "https://wiki.example.org/" or ":80"; undefined when empty. */
function parseDomain(raw) {
  const value = (raw ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!value) return undefined;
  if (!/^(:\d{1,5}|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?)$/i.test(value)) {
    console.error(`DOMAIN="${raw}" ist kein gültiger Hostname (Beispiel: wiki.example.org).`);
    process.exit(1);
  }
  return value;
}

fs.mkdirSync(SECRETS, { recursive: true });
fs.mkdirSync(CADDY_DIR, { recursive: true });

// 1. Secrets. Postgres (uid 70) and Wiki.js (uid 1000) both read the password file.
if (ensureSecret(path.join(SECRETS, 'postgres_password'), randomBytes(24).toString('base64url'), 0o644)) {
  log('Postgres-Passwort erzeugt.');
}
if (ensureSecret(path.join(SECRETS, 'session.env'), `MCP_SESSION_SECRET=${randomBytes(32).toString('base64url')}\n`, 0o600)) {
  log('MCP_SESSION_SECRET erzeugt.');
}

// 2. Public address. ":80"-style addresses carry no hostname, so no public URL then.
const domain = parseDomain(process.env.DOMAIN);
const publicUrl = domain && !domain.startsWith(':') ? `https://${domain}` : undefined;
writeAtomic(
  path.join(SECRETS, 'public.env'),
  publicUrl ? `PUBLIC_BASE_URL=${publicUrl}\nPUBLIC_URL=${publicUrl}\n` : '',
  0o644,
);

// 3. Caddyfile.
let caddyfile;
if (domain) {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(PLACEHOLDER)) {
    console.error(`Vorlage ${TEMPLATE} enthält ${PLACEHOLDER} nicht — Caddyfile-Format geändert?`);
    process.exit(1);
  }
  caddyfile = template.replace(PLACEHOLDER, domain);
} else {
  caddyfile = [
    ':80 {',
    '\theader Content-Type "text/plain; charset=utf-8"',
    '\trespond "Wiki.js + MCP: noch nicht eingerichtet.',
    '',
    'Im Docker-Panel (bzw. in der .env) DOMAIN, ADMIN_EMAIL und ADMIN_PASSWORD setzen',
    'und das Projekt neu bereitstellen. Details: deploy/standalone im Repository." 503',
    '}',
    '',
  ].join('\n');
}
writeAtomic(path.join(CADDY_DIR, 'Caddyfile'), caddyfile, 0o644);

log(domain ? `Domain: ${domain}${publicUrl ? `  ·  öffentliche Adresse: ${publicUrl}` : ''}` : 'DOMAIN nicht gesetzt — Caddy zeigt eine Hinweisseite.');
