#!/usr/bin/env node
/**
 * Erstinbetriebnahme des Wiki-Stacks — automatisiert die Schritte, die sonst
 * im Browser-Setup-Wizard und der Admin-UI anfallen. IDEMPOTENT: bereits
 * erledigte Schritte werden erkannt und übersprungen, das Skript kann
 * jederzeit erneut laufen.
 *
 *   1. Wiki.js finalisieren (Admin-Konto anlegen), falls noch im Setup-Modus
 *   2. Startseite + Anwender-Anleitung /ki-zugang anlegen, falls nicht vorhanden
 *   3. optional --locale=de   Standardsprache umstellen + Seiten migrieren
 *   4. PostgreSQL-Suchmaschine aktivieren (bessere Agenten-Suche) + Index-Rebuild
 *   5. optional --demo        Gruppe "Team" (lesen/schreiben, kein Löschen)
 *                             + Testnutzer anlegen
 *
 * Schritte 3–5 ändern nur, was vom Soll abweicht. Der automatische Lauf bei
 * jedem Deploy (--if-configured) setzt Sprache und Suchmaschine nur, solange das
 * Wiki noch unbenutzt ist (nur Startseite und /ki-zugang, keine Sprach-Namespaces),
 * und die Rechte der
 * Gruppe "Team" nur, solange sie noch die Wiki.js-Standardrechte hat; was Admins
 * später in Wiki.js ändern, bleibt erhalten (Audit A-36). Eine abgebrochene
 * Ersteinrichtung vollendet der nächste Lauf. Ein manueller Lauf oder --reapply
 * stellt das Soll her.
 *
 * In docker-compose.yml und deploy/standalone/full läuft es automatisch (Dienst
 * bootstrap, mit --if-configured). Mit docker-compose.build.yml
 * (COMPOSE_FILE in der .env) nach `docker compose up -d`:
 *   ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='...' \
 *     docker compose run --rm bootstrap [--locale=de] [--demo]
 * Der Dienst spricht im internen Netz mit http://wiki:3000 und setzt PUBLIC_URL
 * aus PUBLIC_BASE_URL bzw. https://$DOMAIN.
 *
 * Direkt auf dem Host (Node >= 18) — für ein frisches Wiki nur noch gegen den
 * internen Port, denn Caddy beantwortet den Setup-Endpunkt /finalize immer mit
 * 403. Über Caddy funktioniert der Host-Aufruf nur für BEREITS eingerichtete Wikis:
 *   WIKI_URL=https://wiki.example.org ADMIN_EMAIL=... ADMIN_PASSWORD='...' \
 *     node deploy/scripts/bootstrap.mjs [--locale=de] [--demo]
 *
 * Env: WIKI_URL   Adresse, unter der das Skript Wiki.js erreicht
 *                 (Default http://localhost:8090, der lokale Test-Stack).
 *      PUBLIC_URL öffentliche Adresse: Connector-URL auf /ki-zugang und
 *                 Site-URL von Wiki.js (Default: WIKI_URL).
 *      ADMIN_EMAIL, ADMIN_PASSWORD,
 *      DEMO_EMAIL/DEMO_NAME (nur mit --demo, haben Defaults),
 *      DEMO_PASSWORD (Pflicht mit --demo).
 *      BOOTSTRAP_ARGS zusätzliche Parameter, durch Leerzeichen getrennt (für
 *                 Compose-Dateien ohne Shell, z. B. "--locale=en --demo");
 *                 sie stehen hinter den Kommandozeilen-Parametern und gewinnen.
 *
 * --reapply       mit --if-configured: Sprache, Suchmaschine und Gruppe "Team" wie
 *                  bei einem manuellen Lauf wieder auf das Soll setzen.
 * --if-configured  ohne ADMIN_EMAIL/ADMIN_PASSWORD oder ohne PUBLIC_URL still
 *                  beenden (Exit 0) statt mit Fehler bzw. statt WIKI_URL als
 *                  öffentliche Adresse zu nehmen — für den automatischen Start in
 *                  docker-compose.yml und deploy/standalone/full.
 */

const WIKI_URL = (process.env.WIKI_URL || 'http://localhost:8090').replace(/\/+$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || WIKI_URL).replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ARGS = [...process.argv.slice(2), ...(process.env.BOOTSTRAP_ARGS ?? '').split(/\s+/).filter(Boolean)];
const WITH_DEMO = ARGS.includes('--demo');
const IF_CONFIGURED = ARGS.includes('--if-configured');
// The automatic run touches language, search engine and the Team group only at first
// setup; --reapply (e.g. BOOTSTRAP_ARGS in a panel without a shell) sets them again.
const KEEP_ADMIN_CHOICES = IF_CONFIGURED && !ARGS.includes('--reapply');
// Last one wins, so BOOTSTRAP_ARGS can override a --locale default from the command line.
const LOCALE = (ARGS.findLast((a) => a.startsWith('--locale=')) ?? '').split('=')[1];

// No hardcoded default password: a committed default would ship a
// write-capable, publicly-known account into any wiki this runs against.
const DEMO = {
  email: process.env.DEMO_EMAIL || 'test@team.local',
  name: process.env.DEMO_NAME || 'Test-Zugang',
  password: process.env.DEMO_PASSWORD,
};

/** What Wiki.js gives a new group (server/app/data.yml) — "Team" not configured yet. */
const WIKI_DEFAULT_PERMS = ['read:pages', 'read:assets', 'read:comments', 'write:comments'];

const TEAM_PERMS = [
  'read:pages', 'write:pages', 'read:assets', 'write:assets',
  'read:comments', 'write:comments', 'read:source', 'read:history',
];

if ((!ADMIN_EMAIL || !ADMIN_PASSWORD) && IF_CONFIGURED) {
  console.log('• ADMIN_EMAIL/ADMIN_PASSWORD nicht gesetzt — Ersteinrichtung übersprungen.');
  process.exit(0);
}
// The address goes into /ki-zugang and is never corrected by re-runs, so the
// automatic start waits for a real public address instead of using WIKI_URL.
if (!process.env.PUBLIC_URL && IF_CONFIGURED) {
  console.log('• Keine öffentliche Adresse (DOMAIN) gesetzt — Ersteinrichtung übersprungen.');
  process.exit(0);
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL und ADMIN_PASSWORD müssen als Umgebungsvariablen gesetzt sein.');
  process.exit(1);
}
// Locale codes as Wiki.js names them (de, en, pt-br, zh-tw …). They go out as
// GraphQL variables anyway; the check turns a typo into an error before any change.
if (LOCALE !== undefined && !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(LOCALE)) {
  console.error(`--locale=${LOCALE} ist kein gültiger Sprachcode (z. B. de, en, pt-br).`);
  process.exit(1);
}
if (WITH_DEMO && !DEMO.password) {
  console.error('--demo verlangt DEMO_PASSWORD (kein Default — sonst entstünde ein Konto mit öffentlich bekanntem Passwort).');
  process.exit(1);
}

const log = (msg) => console.log('•', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wiki.js reports refusals in responseResult, not as GraphQL errors: check every one. */
function assertSucceeded(rr, what) {
  if (!rr?.succeeded) throw new Error(`${what} fehlgeschlagen: ${rr?.message || 'keine Antwort von Wiki.js'}`);
}

async function gql(query, variables = {}, jwt) {
  const res = await fetch(`${WIKI_URL}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

async function waitForWiki() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${WIKI_URL}/`, { redirect: 'manual' });
      if (r.status < 500) return;
    } catch { /* container still starting */ }
    await sleep(3000);
  }
  throw new Error(`Wiki.js unter ${WIKI_URL} nicht erreichbar — läuft der Stack? (docker compose up -d)`);
}

async function adminLogin() {
  const d = await gql(
    'mutation($u:String!,$p:String!){ authentication { login(username:$u,password:$p,strategy:"local"){ jwt responseResult { succeeded message } } } }',
    { u: ADMIN_EMAIL, p: ADMIN_PASSWORD },
  );
  const l = d.authentication.login;
  if (!l.responseResult?.succeeded || !l.jwt) return null;
  return l.jwt;
}

/**
 * Setup mode answers every GET with the setup page (HTML); the normal server
 * answers /healthz with JSON. Probing /graphql instead would 404 in setup mode
 * and crash Wiki.js' own error handler (TypeError …'sendError' in the log).
 */
async function isSetupMode() {
  const r = await fetch(`${WIKI_URL}/healthz`);
  // Status 200 too: a proxy's or Wiki.js' own HTML error page is not the setup page.
  return r.status === 200 && (r.headers.get('content-type') ?? '').includes('text/html');
}

/**
 * Step 1 — finalize the first-run setup, or log in to an already set-up wiki.
 * `fresh` = this run set the wiki up; the automatic run configures only then.
 */
async function ensureFinalized() {
  let jwt;
  if (!(await isSetupMode())) {
    jwt = await adminLogin();
    if (!jwt) throw new Error('Wiki.js ist bereits eingerichtet, aber der Admin-Login schlägt fehl — ADMIN_EMAIL/ADMIN_PASSWORD prüfen.');
    log('Wiki.js ist bereits eingerichtet (Admin-Login funktioniert).');
    return { jwt, fresh: false };
  }
  log('Setup-Modus erkannt — lege das Admin-Konto an …');
  const res = await fetch(`${WIKI_URL}/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD, siteUrl: PUBLIC_URL, telemetry: false }),
  });
  if (res.status === 403) {
    throw new Error('Finalize gesperrt (HTTP 403): der Proxy blockt /finalize — Ersteinrichtung mit `docker compose run --rm bootstrap`.');
  }
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Finalize fehlgeschlagen: HTTP ${res.status} ${JSON.stringify(body)}`);
  log('Admin-Konto angelegt — Wiki.js startet neu …');
  // Wiki.js restarts itself after finalize; wait until the login works.
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    if (await isSetupMode().catch(() => true)) continue; // still restarting
    jwt = await adminLogin().catch(() => null);
    if (jwt) return { jwt, fresh: true };
  }
  throw new Error('Wiki.js kam nach dem Setup nicht zurück.');
}

/**
 * Create a page unless one with this path exists in any locale (existing pages
 * are never overwritten — admins may have edited them). New pages go into the
 * wiki's CURRENT default locale, so re-runs on a German wiki stay reachable.
 */
async function ensurePage(jwt, { path, title, description, content }) {
  const found = await gql('query{ pages { list { path } } }', {}, jwt);
  if (found.pages.list.some((p) => p.path === path)) {
    log(`Seite /${path} existiert.`);
    return;
  }
  const loc = await gql('query{ localization { config { locale } } }', {}, jwt);
  const d = await gql(
    'mutation($content:String!,$description:String!,$locale:String!,$path:String!,$title:String!){ pages { create(content:$content,description:$description,editor:"markdown",isPublished:true,isPrivate:false,locale:$locale,path:$path,tags:[],title:$title){ responseResult { succeeded message } } } }',
    { content, description, locale: loc.localization.config.locale, path, title }, jwt,
  );
  if (!d.pages.create.responseResult.succeeded) {
    throw new Error(`Seite /${path} konnte nicht angelegt werden: ${d.pages.create.responseResult.message}`);
  }
  log(`Seite /${path} angelegt.`);
}

const START_PAGES = ['home', 'ki-zugang'];

/**
 * Still in its first setup: no content beyond the start pages, and no language
 * namespaces turned on (that is an admin's multilingual setup).
 */
async function untouchedWiki(jwt) {
  const found = await gql('query{ pages { list { path } } }', {}, jwt);
  if (!found.pages.list.every((p) => START_PAGES.includes(p.path))) return false;
  const loc = await gql('query{ localization { config { namespacing } } }', {}, jwt);
  return !loc.localization.config.namespacing;
}

/** Step 2 — a home page (instead of the setup screen) and the user guide it links to. */
async function ensureStartPages(jwt) {
  await ensurePage(jwt, {
    path: 'home',
    title: 'Team-Wissensspeicher',
    description: 'Startseite',
    content: [
      '# Team-Wissensspeicher',
      '',
      'Willkommen! Dieses Wiki können Menschen **und KI-Assistenten** nutzen — jeweils mit den persönlichen Rechten.',
      '',
      '- KI-Assistenten verbinden: siehe [KI-Zugang](/ki-zugang)',
      '- Inhalte anlegen: oben rechts **Neue Seite**',
    ].join('\n'),
  });
  // The links use PUBLIC_URL — the address users and AI clients reach (see header).
  await ensurePage(jwt, {
    path: 'ki-zugang',
    title: 'KI-Zugang',
    description: 'KI-Assistenten mit dem Wiki verbinden',
    content: [
      '# KI-Zugang',
      '',
      'Dieses Wiki lässt sich mit KI-Assistenten (Claude, ChatGPT, Cursor …) nutzen — mit **deinen** Wiki-Rechten.',
      '',
      '## Einrichten',
      '',
      `1. Im KI-Programm diese Adresse als Connector bzw. MCP-Server eintragen: \`${PUBLIC_URL}/mcp\``,
      '   - **claude.ai / Claude Desktop:** Einstellungen → Connectors → *Add custom connector*',
      `   - **Claude Code:** \`claude mcp add --transport http wiki ${PUBLIC_URL}/mcp\`, danach \`/mcp\` → *Authenticate*`,
      '   - **ChatGPT / Codex / Cursor:** Connector bzw. MCP-Server mit der Adresse anlegen',
      '2. Beim ersten Verbinden öffnet sich der Wiki-Login: mit dem normalen Wiki-Konto anmelden und **Zugriff erlauben**.',
      '3. Fertig. Die KI sieht und ändert nur, was du selbst im Wiki darfst.',
      '',
      '## Gut zu wissen',
      '',
      // Phrased as defaults: the actual guardrails are MCP server settings this script cannot see.
      '- Standardmäßig fragt die KI vor dem Löschen und vor Admin-Aktionen nach einer ausdrücklichen Bestätigung.',
      '- Seiten mit dem Sperr-Tag (Standard: `kein-ki`) sind für KI-Assistenten unsichtbar und nicht änderbar — welcher Tag gilt, legt die IT fest.',
      `- Eigene KI-Verbindungen ansehen und widerrufen: [${PUBLIC_URL}/me](${PUBLIC_URL}/me)`,
    ].join('\n'),
  });
}

const DICT_BY_LOCALE = { de: 'german', en: 'english', fr: 'french', es: 'spanish', it: 'italian', nl: 'dutch', pt: 'portuguese', ru: 'russian' };

/** Step 4 — the PostgreSQL search engine beats the default DB search by far.
 *  The dictionary follows the wiki's ACTUAL locale. */
async function ensureSearchEngine(jwt, fresh) {
  const s = await gql('query{ search { searchEngines { key isEnabled config { key value } } } }', {}, jwt);
  const enabled = s.search.searchEngines.filter((e) => e.isEnabled);
  const active = enabled.map((e) => e.key).join(', ') || 'keine';
  if (active === 'postgres') {
    log('PostgreSQL-Suche ist aktiv.');
    return;
  }
  if (KEEP_ADMIN_CHOICES && !fresh) {
    log(`Suchmaschine bleibt "${active}" (in Wiki.js gewählt). PostgreSQL-Suche bei Bedarf: einmal mit BOOTSTRAP_ARGS=--reapply bereitstellen.`);
    return;
  }
  const loc = await gql('query{ localization { config { locale } } }', {}, jwt);
  const dict = DICT_BY_LOCALE[loc.localization.config.locale] ?? 'simple';
  // Wiki.js patches isEnabled AND config of every listed engine and activates the one
  // it finds enabled: switch every other enabled engine off, sending its own config back
  // (the query returns {value}, the mutation takes {v}) so nothing of it is lost.
  const keepConfig = (config) => (config ?? []).map((c) => ({ key: c.key, value: JSON.stringify({ v: JSON.parse(c.value).value }) }));
  const off = enabled.filter((e) => e.key !== 'postgres').map((e) => ({ key: e.key, isEnabled: false, config: keepConfig(e.config) }));
  const u = await gql(
    'mutation($engines:[SearchEngineInput]){ search { updateSearchEngines(engines:$engines){ responseResult { succeeded message } } } }',
    { engines: [...off, { key: 'postgres', isEnabled: true, config: [{ key: 'dictLanguage', value: JSON.stringify({ v: dict }) }] }] },
    jwt,
  );
  assertSucceeded(u.search.updateSearchEngines.responseResult, 'Suchmaschine umstellen');
  await rebuildIndex(jwt);
  log(`PostgreSQL-Suche aktiv (Wörterbuch: ${dict}), Index neu aufgebaut.`);
}

/**
 * Step 3 (optional) — switch the site language and move the pages of the old
 * default language along. Never on a wiki that already has the language, and on
 * the automatic run only at first setup — otherwise every deploy would move pages
 * an editor deliberately created in another language (A-36).
 */
async function switchLocale(jwt, fresh) {
  const loc = await gql('query{ localization { config { locale } } }', {}, jwt);
  const current = loc.localization.config.locale;
  if (current === LOCALE) {
    // A first setup can break off between setting the language and moving the pages;
    // finish the move then (only then — later pages in other languages are deliberate).
    const pages = fresh ? (await gql('query{ pages { list { path locale } } }', {}, jwt)).pages.list : [];
    const sources = [...new Set(pages.map((p) => p.locale).filter((l) => l !== LOCALE))];
    if (sources.length === 0) {
      log(`Standardsprache ist ${LOCALE}.`);
      return;
    }
    let moved = 0;
    for (const source of sources) moved += await migratePages(jwt, source);
    await rebuildIndex(jwt);
    log(`Standardsprache ${LOCALE}: ${moved} Seiten aus ${sources.join(', ')} nachträglich verschoben, Suchindex erneuert.`);
    return;
  }
  if (KEEP_ADMIN_CHOICES && !fresh) {
    log(`Standardsprache bleibt ${current} (in Wiki.js gewählt). Umstellen: einmal mit BOOTSTRAP_ARGS=--reapply bereitstellen.`);
    return;
  }
  const vars = { locale: LOCALE };
  const dl = await gql('mutation($locale:String!){ localization { downloadLocale(locale:$locale){ responseResult { succeeded message } } } }', vars, jwt);
  assertSucceeded(dl.localization.downloadLocale.responseResult, `Sprachpaket ${LOCALE} laden`);
  const up = await gql(
    'mutation($locale:String!){ localization { updateLocale(locale:$locale,autoUpdate:true,namespacing:false,namespaces:[]){ responseResult { succeeded message } } } }',
    vars, jwt,
  );
  assertSucceeded(up.localization.updateLocale.responseResult, `Standardsprache ${LOCALE} setzen`);
  const moved = await migratePages(jwt, current);
  await rebuildIndex(jwt);
  log(`Standardsprache ${LOCALE}, ${moved} Seiten aus ${current} verschoben, Suchindex erneuert.`);
}

/** Move all pages of `source` into LOCALE; returns how many moved. */
async function migratePages(jwt, source) {
  const mig = await gql(
    'mutation($sourceLocale:String!,$targetLocale:String!){ pages { migrateToLocale(sourceLocale:$sourceLocale,targetLocale:$targetLocale){ responseResult { succeeded message } count } } }',
    { sourceLocale: source, targetLocale: LOCALE }, jwt,
  );
  assertSucceeded(mig.pages.migrateToLocale.responseResult, `Seiten von ${source} nach ${LOCALE} verschieben`);
  return mig.pages.migrateToLocale.count ?? 0;
}

async function rebuildIndex(jwt) {
  const r = await gql('mutation{ search { rebuildIndex { responseResult { succeeded message } } } }', {}, jwt);
  assertSucceeded(r.search.rebuildIndex.responseResult, 'Suchindex aufbauen');
}

/**
 * Step 5 (optional) — a "Team" group (read/write, no delete/admin) + demo user.
 * The automatic run sets the group's rights only when it creates the group, so
 * rights an admin adjusted later survive every deploy (A-36).
 */
async function ensureDemo(jwt) {
  const groups = await gql('{ groups { list { id name } } }', {}, jwt);
  let team = groups.groups.list.find((g) => g.name === 'Team');
  const created = !team;
  let unconfigured = false;
  if (!created) {
    const g = await gql('query($id:Int!){ groups { single(id:$id){ permissions } } }', { id: team.id }, jwt);
    const perms = g.groups.single?.permissions ?? [];
    unconfigured = perms.length === WIKI_DEFAULT_PERMS.length && WIKI_DEFAULT_PERMS.every((p) => perms.includes(p));
  }
  if (created) {
    const c = await gql(
      'mutation($name:String!){ groups { create(name:$name){ responseResult { succeeded message } group { id } } } }',
      { name: 'Team' }, jwt,
    );
    assertSucceeded(c.groups.create.responseResult, 'Gruppe "Team" anlegen');
    team = c.groups.create.group;
    if (!team?.id) throw new Error('Gruppe "Team" angelegt, aber Wiki.js nennt keine id.');
  }
  if (created || unconfigured || !KEEP_ADMIN_CHOICES) {
    const u = await gql(
      'mutation($id:Int!,$name:String!,$redirectOnLogin:String!,$permissions:[String]!,$pageRules:[PageRuleInput]!){ groups { update(id:$id,name:$name,redirectOnLogin:$redirectOnLogin,permissions:$permissions,pageRules:$pageRules){ responseResult { succeeded message } } } }',
      {
        id: team.id, name: 'Team', redirectOnLogin: '/',
        permissions: TEAM_PERMS,
        pageRules: [{ id: 'team-all', deny: false, match: 'START', roles: TEAM_PERMS, path: '', locales: [] }],
      }, jwt,
    );
    assertSucceeded(u.groups.update.responseResult, 'Rechte der Gruppe "Team" setzen');
    log(`Gruppe "Team" (id ${team.id}): lesen/schreiben, kein Löschen, kein Admin.`);
  } else {
    log(`Gruppe "Team" (id ${team.id}) existiert — Rechte bleiben, wie sie in Wiki.js eingestellt sind.`);
  }

  const found = await gql('query($q:String!){ users { search(query:$q) { id email } } }', { q: DEMO.email }, jwt);
  if (!found.users.search.some((u) => u.email === DEMO.email)) {
    const c = await gql(
      'mutation($email:String!,$name:String!,$passwordRaw:String,$providerKey:String!,$groups:[Int]!,$mustChangePassword:Boolean,$sendWelcomeEmail:Boolean){ users { create(email:$email,name:$name,passwordRaw:$passwordRaw,providerKey:$providerKey,groups:$groups,mustChangePassword:$mustChangePassword,sendWelcomeEmail:$sendWelcomeEmail){ responseResult { succeeded message } } } }',
      { email: DEMO.email, name: DEMO.name, passwordRaw: DEMO.password, providerKey: 'local', groups: [team.id], mustChangePassword: false, sendWelcomeEmail: false },
      jwt,
    );
    assertSucceeded(c.users.create.responseResult, `Testnutzer ${DEMO.email} anlegen`);
    log(`Testnutzer ${DEMO.email} angelegt (Gruppe "Team").`);
  } else {
    log(`Testnutzer ${DEMO.email} existiert.`);
  }
}

log(`Ziel: ${WIKI_URL}` + (PUBLIC_URL !== WIKI_URL ? `  ·  öffentliche Adresse: ${PUBLIC_URL}` : ''));
if (!process.env.WIKI_URL && !process.env.PUBLIC_URL) {
  // The address is written into the public page /ki-zugang and never corrected by re-runs.
  console.warn(
    '⚠ WIKI_URL ist nicht gesetzt — /ki-zugang zeigt dann http://localhost:8090 als Connector-Adresse.\n' +
      '  Auf einem Server mit Domain abbrechen und `docker compose run --rm bootstrap` nutzen.',
  );
}
await waitForWiki();
const finalized = await ensureFinalized();
const jwt = finalized.jwt;
await ensureStartPages(jwt);
// First setup = this run finalized the wiki, or it still holds nothing but the start
// pages — so a setup that broke off after /finalize is completed by the restart.
const fresh = finalized.fresh || (await untouchedWiki(jwt));
if (LOCALE) await switchLocale(jwt, fresh);
await ensureSearchEngine(jwt, fresh);
if (WITH_DEMO) await ensureDemo(jwt);
log('Fertig. Anmelden: ' + PUBLIC_URL + '  ·  KI-Verbindungen: ' + PUBLIC_URL + '/me');
