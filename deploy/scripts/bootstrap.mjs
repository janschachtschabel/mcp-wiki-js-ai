#!/usr/bin/env node
/**
 * Erstinbetriebnahme des Wiki-Stacks — automatisiert die Schritte, die sonst
 * im Browser-Setup-Wizard und der Admin-UI anfallen. IDEMPOTENT: bereits
 * erledigte Schritte werden erkannt und übersprungen, das Skript kann
 * jederzeit erneut laufen.
 *
 *   1. Wiki.js finalisieren (Admin-Konto anlegen), falls noch im Setup-Modus
 *   2. Startseite + Anwender-Anleitung /ki-zugang anlegen, falls nicht vorhanden
 *   3. PostgreSQL-Suchmaschine aktivieren (bessere Agenten-Suche) + Index-Rebuild
 *   4. optional --locale=de   Standardsprache umstellen + Seiten migrieren
 *   5. optional --demo        Gruppe "Team" (lesen/schreiben, kein Löschen)
 *                             + Testnutzer anlegen
 *
 * Aufruf (Node >= 18, nach `docker compose up -d`):
 *   ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='...' \
 *     node deploy/scripts/bootstrap.mjs [--locale=de] [--demo]
 *
 * Env: WIKI_URL (Default http://localhost:8090) — in Produktion die ÖFFENTLICHE
 *      Adresse, sie steht als Connector-URL auf der Seite /ki-zugang.
 *      ADMIN_EMAIL, ADMIN_PASSWORD,
 *      DEMO_EMAIL/DEMO_PASSWORD/DEMO_NAME (nur mit --demo, haben Defaults).
 */

const WIKI_URL = (process.env.WIKI_URL || 'http://localhost:8090').replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const WITH_DEMO = process.argv.includes('--demo');
const LOCALE = (process.argv.find((a) => a.startsWith('--locale=')) ?? '').split('=')[1];

// No hardcoded default password: a committed default would ship a
// write-capable, publicly-known account into any wiki this runs against.
const DEMO = {
  email: process.env.DEMO_EMAIL || 'test@team.local',
  name: process.env.DEMO_NAME || 'Test-Zugang',
  password: process.env.DEMO_PASSWORD,
};

const TEAM_PERMS = [
  'read:pages', 'write:pages', 'read:assets', 'write:assets',
  'read:comments', 'write:comments', 'read:source', 'read:history',
];

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL und ADMIN_PASSWORD müssen als Umgebungsvariablen gesetzt sein.');
  process.exit(1);
}
if (WITH_DEMO && !DEMO.password) {
  console.error('--demo verlangt DEMO_PASSWORD (kein Default — sonst entstünde ein Konto mit öffentlich bekanntem Passwort).');
  process.exit(1);
}

const log = (msg) => console.log('•', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Step 1 — finalize the first-run setup, or log in to an already set-up wiki. */
async function ensureFinalized() {
  let jwt;
  if (!(await isSetupMode())) {
    jwt = await adminLogin();
    if (!jwt) throw new Error('Wiki.js ist bereits eingerichtet, aber der Admin-Login schlägt fehl — ADMIN_EMAIL/ADMIN_PASSWORD prüfen.');
    log('Wiki.js ist bereits eingerichtet (Admin-Login funktioniert).');
    return jwt;
  }
  log('Setup-Modus erkannt — lege das Admin-Konto an …');
  const res = await fetch(`${WIKI_URL}/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD, siteUrl: WIKI_URL, telemetry: false }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Finalize fehlgeschlagen: HTTP ${res.status} ${JSON.stringify(body)}`);
  log('Admin-Konto angelegt — Wiki.js startet neu …');
  // Wiki.js restarts itself after finalize; wait until the login works.
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    if (await isSetupMode().catch(() => true)) continue; // still restarting
    jwt = await adminLogin().catch(() => null);
    if (jwt) return jwt;
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
  // The links use WIKI_URL — run the bootstrap with the PUBLIC address (see header).
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
      `1. Im KI-Programm diese Adresse als Connector bzw. MCP-Server eintragen: \`${WIKI_URL}/mcp\``,
      '   - **claude.ai / Claude Desktop:** Einstellungen → Connectors → *Add custom connector*',
      `   - **Claude Code:** \`claude mcp add --transport http wiki ${WIKI_URL}/mcp\`, danach \`/mcp\` → *Authenticate*`,
      '   - **ChatGPT / Codex / Cursor:** Connector bzw. MCP-Server mit der Adresse anlegen',
      '2. Beim ersten Verbinden öffnet sich der Wiki-Login: mit dem normalen Wiki-Konto anmelden und **Zugriff erlauben**.',
      '3. Fertig. Die KI sieht und ändert nur, was du selbst im Wiki darfst.',
      '',
      '## Gut zu wissen',
      '',
      // Phrased as defaults: the actual guardrails are MCP server settings this script cannot see.
      '- Standardmäßig fragt die KI vor dem Löschen und vor Admin-Aktionen nach einer ausdrücklichen Bestätigung.',
      '- Seiten mit dem Sperr-Tag (Standard: `kein-ki`) sind für KI-Assistenten unsichtbar und nicht änderbar — welcher Tag gilt, legt die IT fest.',
      `- Eigene KI-Verbindungen ansehen und widerrufen: [${WIKI_URL}/me](${WIKI_URL}/me)`,
    ].join('\n'),
  });
}

const DICT_BY_LOCALE = { de: 'german', en: 'english', fr: 'french', es: 'spanish', it: 'italian', nl: 'dutch', pt: 'portuguese', ru: 'russian' };

/** Step 3 — the PostgreSQL search engine beats the default DB search by far.
 *  The dictionary follows the wiki's ACTUAL locale, so re-runs never downgrade it. */
async function ensureSearchEngine(jwt) {
  const loc = await gql('query{ localization { config { locale } } }', {}, jwt);
  const dict = DICT_BY_LOCALE[loc.localization.config.locale] ?? 'simple';
  await gql(
    'mutation($engines:[SearchEngineInput]){ search { updateSearchEngines(engines:$engines){ responseResult { succeeded message } } } }',
    {
      engines: [
        { key: 'db', isEnabled: false, config: [] },
        { key: 'postgres', isEnabled: true, config: [{ key: 'dictLanguage', value: JSON.stringify({ v: dict }) }] },
      ],
    },
    jwt,
  );
  await gql('mutation{ search { rebuildIndex { responseResult { succeeded } } } }', {}, jwt);
  log(`PostgreSQL-Suche aktiv (Wörterbuch: ${dict}), Index neu aufgebaut.`);
}

/** Step 4 (optional) — switch the site to German and migrate existing pages. */
async function switchLocale(jwt) {
  await gql(`mutation{ localization { downloadLocale(locale:"${LOCALE}"){ responseResult { succeeded } } } }`, {}, jwt);
  await gql(
    `mutation{ localization { updateLocale(locale:"${LOCALE}",autoUpdate:true,namespacing:false,namespaces:[]){ responseResult { succeeded } } } }`,
    {}, jwt,
  );
  const mig = await gql(
    `mutation{ pages { migrateToLocale(sourceLocale:"en",targetLocale:"${LOCALE}"){ responseResult { succeeded } count } } }`,
    {}, jwt,
  );
  await gql('mutation{ search { rebuildIndex { responseResult { succeeded } } } }', {}, jwt);
  log(`Standardsprache ${LOCALE}, ${mig.pages.migrateToLocale.count ?? 0} Seiten migriert, Suchindex erneuert.`);
}

/** Step 5 (optional) — a "Team" group (read/write, no delete/admin) + demo user. */
async function ensureDemo(jwt) {
  const groups = await gql('{ groups { list { id name } } }', {}, jwt);
  let team = groups.groups.list.find((g) => g.name === 'Team');
  if (!team) {
    const c = await gql(
      'mutation($name:String!){ groups { create(name:$name){ responseResult { succeeded } group { id } } } }',
      { name: 'Team' }, jwt,
    );
    team = c.groups.create.group;
  }
  await gql(
    'mutation($id:Int!,$name:String!,$redirectOnLogin:String!,$permissions:[String]!,$pageRules:[PageRuleInput]!){ groups { update(id:$id,name:$name,redirectOnLogin:$redirectOnLogin,permissions:$permissions,pageRules:$pageRules){ responseResult { succeeded } } } }',
    {
      id: team.id, name: 'Team', redirectOnLogin: '/',
      permissions: TEAM_PERMS,
      pageRules: [{ id: 'team-all', deny: false, match: 'START', roles: TEAM_PERMS, path: '', locales: [] }],
    }, jwt,
  );
  log(`Gruppe "Team" (id ${team.id}): lesen/schreiben, kein Löschen, kein Admin.`);

  const found = await gql('query($q:String!){ users { search(query:$q) { id email } } }', { q: DEMO.email }, jwt);
  if (!found.users.search.some((u) => u.email === DEMO.email)) {
    await gql(
      'mutation($email:String!,$name:String!,$passwordRaw:String,$providerKey:String!,$groups:[Int]!,$mustChangePassword:Boolean,$sendWelcomeEmail:Boolean){ users { create(email:$email,name:$name,passwordRaw:$passwordRaw,providerKey:$providerKey,groups:$groups,mustChangePassword:$mustChangePassword,sendWelcomeEmail:$sendWelcomeEmail){ responseResult { succeeded message } } } }',
      { email: DEMO.email, name: DEMO.name, passwordRaw: DEMO.password, providerKey: 'local', groups: [team.id], mustChangePassword: false, sendWelcomeEmail: false },
      jwt,
    );
    log(`Testnutzer ${DEMO.email} angelegt (Gruppe "Team").`);
  } else {
    log(`Testnutzer ${DEMO.email} existiert.`);
  }
}

log(`Ziel: ${WIKI_URL}`);
if (!process.env.WIKI_URL) {
  // The address is written into the public page /ki-zugang and never corrected by re-runs.
  console.warn(
    '⚠ WIKI_URL ist nicht gesetzt — /ki-zugang zeigt dann http://localhost:8090 als Connector-Adresse.\n' +
      '  Auf einem Server mit Domain abbrechen und mit WIKI_URL=https://<domain> neu starten.',
  );
}
await waitForWiki();
const jwt = await ensureFinalized();
await ensureStartPages(jwt);
if (LOCALE) await switchLocale(jwt);
await ensureSearchEngine(jwt);
if (WITH_DEMO) await ensureDemo(jwt);
log('Fertig. Anmelden: ' + WIKI_URL + '  ·  KI-Verbindungen: ' + WIKI_URL + '/me');
