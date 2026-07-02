#!/usr/bin/env node
/**
 * Erstinbetriebnahme des Wiki-Stacks — automatisiert die Schritte, die sonst
 * im Browser-Setup-Wizard und der Admin-UI anfallen. IDEMPOTENT: bereits
 * erledigte Schritte werden erkannt und übersprungen, das Skript kann
 * jederzeit erneut laufen.
 *
 *   1. Wiki.js finalisieren (Admin-Konto anlegen), falls noch im Setup-Modus
 *   2. Startseite anlegen, falls keine existiert
 *   3. PostgreSQL-Suchmaschine aktivieren (bessere Agenten-Suche) + Index-Rebuild
 *   4. optional --locale=de   Standardsprache umstellen + Seiten migrieren
 *   5. optional --demo        Gruppe "Team" (lesen/schreiben, kein Löschen)
 *                             + Testnutzer anlegen
 *
 * Aufruf (Node >= 18, nach `docker compose up -d`):
 *   ADMIN_EMAIL=admin@example.org ADMIN_PASSWORD='...' \
 *     node deploy/scripts/bootstrap.mjs [--locale=de] [--demo]
 *
 * Env: WIKI_URL (Default http://localhost:8090), ADMIN_EMAIL, ADMIN_PASSWORD,
 *      DEMO_EMAIL/DEMO_PASSWORD/DEMO_NAME (nur mit --demo, haben Defaults).
 */

const WIKI_URL = (process.env.WIKI_URL || 'http://localhost:8090').replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const WITH_DEMO = process.argv.includes('--demo');
const LOCALE = (process.argv.find((a) => a.startsWith('--locale=')) ?? '').split('=')[1];

const DEMO = {
  email: process.env.DEMO_EMAIL || 'test@team.local',
  name: process.env.DEMO_NAME || 'Test-Zugang',
  password: process.env.DEMO_PASSWORD || 'WikiTest2026!',
};

const TEAM_PERMS = [
  'read:pages', 'write:pages', 'read:assets', 'write:assets',
  'read:comments', 'write:comments', 'read:source', 'read:history',
];

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL und ADMIN_PASSWORD müssen als Umgebungsvariablen gesetzt sein.');
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

/** Step 1 — finalize the first-run setup unless an admin login already works. */
async function ensureFinalized() {
  let jwt = await adminLogin().catch(() => null);
  if (jwt) {
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
    jwt = await adminLogin().catch(() => null);
    if (jwt) return jwt;
  }
  throw new Error('Wiki.js kam nach dem Setup nicht zurück.');
}

/** Step 2 — a home page, so the site does not greet users with the setup screen. */
async function ensureHomePage(jwt) {
  const found = await gql(
    'query{ pages { list { id path locale } } }', {}, jwt,
  );
  if (found.pages.list.some((p) => p.path === 'home')) {
    log('Startseite existiert.');
    return;
  }
  const content = [
    '# Team-Wissensspeicher',
    '',
    'Willkommen! Dieses Wiki können Menschen **und KI-Assistenten** nutzen — jeweils mit den persönlichen Rechten.',
    '',
    '- KI-Zugang einrichten: siehe Seite `/ki-zugang` (bzw. `/me` für deine Verbindungen)',
    '- Inhalte anlegen: oben rechts **Neue Seite**',
  ].join('\n');
  await gql(
    `mutation($content:String!){ pages { create(content:$content,description:"Startseite",editor:"markdown",isPublished:true,isPrivate:false,locale:"en",path:"home",tags:[],title:"Team-Wissensspeicher"){ responseResult { succeeded message } } } }`,
    { content }, jwt,
  );
  log('Startseite angelegt.');
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
await waitForWiki();
const jwt = await ensureFinalized();
await ensureHomePage(jwt);
if (LOCALE) await switchLocale(jwt);
await ensureSearchEngine(jwt);
if (WITH_DEMO) await ensureDemo(jwt);
log('Fertig. Anmelden: ' + WIKI_URL + '  ·  KI-Verbindungen: ' + WIKI_URL + '/me');
