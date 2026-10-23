// Live end-to-end test of the wikijs-mcp appliance. Exercises the REAL system
// against a running stack: Wiki.js login → OAuth code → tokens → MCP tool calls
// → guardrails → page tools as a non-admin team user → /me (incl. the
// admin-vs-non-admin rendering gate).
//
// Prerequisites (like scripts/test-local-live.ts, this needs a live wiki):
//   docker compose -f docker-compose.yml -f docker-compose.local.yml up -d   (repo root)
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... DEMO_PASSWORD=... docker compose \
//     -f docker-compose.yml -f docker-compose.local.yml run --rm bootstrap --demo
//   npm run test:e2e
//
// Base URL + credentials come from env (defaults match the documented local
// fixtures); set E2E_BASE to a tunnel URL to test from outside.
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.E2E_BASE || 'http://localhost:8090';
const ADMIN = { user: process.env.E2E_ADMIN_USER || 'admin@example.com', pass: process.env.E2E_ADMIN_PASS || 'Test12345!' };
const DEMO = { user: process.env.E2E_DEMO_USER || 'test@team.local', pass: process.env.E2E_DEMO_PASS || 'WikiTest2026!' };

let pass = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('ok  -', name); }
  else { failed++; console.log('FAIL-', name, detail); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWiki() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/graphql`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ site { config { title } } }' }),
      });
      if (r.status === 200 || r.status === 400) return true; // wiki answers (400 = auth'd schema errors are fine)
    } catch { /* retry */ }
    await sleep(3000);
  }
  return false;
}

/** Parse a streamable-HTTP MCP response (SSE or plain JSON). */
async function mcpParse(res) {
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : undefined;
  }
  try { return JSON.parse(text); } catch { return undefined; }
}

let mcpSession;
async function mcp(method, params, token, id = 1) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  };
  if (mcpSession) headers['mcp-session-id'] = mcpSession;
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
  });
  mcpSession = res.headers.get('mcp-session-id') ?? mcpSession;
  return { status: res.status, body: await mcpParse(res) };
}

/** Like a browser: load a form page and keep its CSRF nonce cookie + hidden field. */
async function formPage(url, cookie) {
  const res = await fetch(url, cookie ? { headers: { cookie } } : {});
  const html = await res.text();
  const nonceCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.includes('csrf')) ?? '';
  const csrf = (html.match(/name="csrf" value="([^"]*)"/) ?? [])[1] ?? '';
  return { res, html, nonceCookie, csrf };
}

/** The mcp_me session cookie (name=value) from a response, if set. */
const meCookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => /mcp_me=/.test(c)) ?? '';

/** tools/call helper returning { isError, text, structured }. */
async function call(tool, args, token) {
  const r = await mcp('tools/call', { name: tool, arguments: args }, token, Math.floor(Math.random() * 1e6));
  const result = r.body?.result;
  return {
    status: r.status,
    isError: Boolean(result?.isError),
    text: result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(r.body),
    structured: result?.structuredContent?.data,
  };
}

/** Full OAuth flow (authorize form → decision → token) for one wiki user; returns the access token. */
async function oauthToken(clientId, user) {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const redirect = 'http://localhost:44444/cb';
  const q = { client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's' };
  const { nonceCookie, csrf } = await formPage(`${BASE}/oauth/authorize?${new URLSearchParams(q)}`);
  const decision = await fetch(`${BASE}/oauth/authorize/decision`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie: nonceCookie },
    body: new URLSearchParams({ ...q, mode: 'credentials', action: 'allow', username: user.user, password: user.pass, csrf }),
  });
  const code = new URL(decision.headers.get('location') ?? 'http://x/').searchParams.get('code') ?? '';
  const tokens = await (await fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }),
  })).json();
  return tokens.access_token;
}

/** Direct Wiki.js GraphQL as admin — test fixture setup/cleanup only, never via the MCP. */
async function wikiAdmin() {
  const post = async (query, variables, jwt) => (await fetch(`${BASE}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify({ query, variables }),
  })).json();
  const login = await post(
    'mutation($u:String!,$p:String!){ authentication { login(username:$u,password:$p,strategy:"local"){ jwt } } }',
    { u: ADMIN.user, p: ADMIN.pass },
  );
  const jwt = login.data?.authentication?.login?.jwt;
  const idOf = async (path) => {
    const r = await post('{ pages { list(locale:"en") { id path } } }', {}, jwt).catch(() => ({}));
    return r.data?.pages?.list?.find((p) => p.path === path)?.id;
  };
  const remove = async (path) => {
    const id = await idOf(path);
    if (id) await post('mutation($id:Int!){ pages { delete(id:$id){ responseResult { succeeded } } } }', { id }, jwt);
  };
  return { ok: typeof jwt === 'string', idOf, remove };
}

/**
 * A-01/A-28: the page tools must work with plain read/write rights (Team group from
 * bootstrap --demo, no manage:pages) — pages.single/singleByPath are admin-only in Wiki.js.
 */
async function teamUserPageTools(clientId) {
  const admin = await wikiAdmin();
  check('team: fixture admin login (direct GraphQL)', admin.ok);
  const TEAM_PATH = 'team/a01-test';
  const MOVED_PATH = 'team/a01-moved';
  await admin.remove(TEAM_PATH);
  await admin.remove(MOVED_PATH);
  const blockedId = await admin.idOf('geheim/ki-sperre-test');

  const token = await oauthToken(clientId, DEMO);
  check('team: OAuth login as the demo team user', typeof token === 'string' && token.startsWith('mcp_at_'));
  const me = await call('wiki_user_profile', {}, token);
  check('team: tool call runs as the team user', !me.isError && me.text.includes(DEMO.user), me.text.slice(0, 200));

  const created = await call('wiki_page_create', { path: TEAM_PATH, title: 'Team A-01', content: 'Team-Start.', locale: 'en' }, token);
  const pageId = created.structured?.id;
  check('team: wiki_page_create', !created.isError && Number.isInteger(pageId), created.text.slice(0, 200));

  const byPath = await call('wiki_page_get', { path: TEAM_PATH, locale: 'en' }, token);
  check('team: wiki_page_get by path returns the content', !byPath.isError && byPath.text.includes('Team-Start.'), byPath.text.slice(0, 200));

  const upd = await call('wiki_page_update', { id: pageId, edits: [{ find: 'Team-Start.', replace: 'Team-Edit.' }] }, token);
  check('team: wiki_page_update by id (edits)', !upd.isError, upd.text.slice(0, 200));
  const byId = await call('wiki_page_get', { id: pageId }, token);
  check('team: wiki_page_get by id shows the edit', !byId.isError && byId.text.includes('Team-Edit.'), byId.text.slice(0, 200));

  const hist = await call('wiki_page_history', { id: pageId }, token);
  check('team: wiki_page_history', !hist.isError && Number(hist.structured?.total) >= 1, hist.text.slice(0, 200));

  // Wiki.js itself requires manage:pages to move a page (@auth on the move mutation, and
  // movePage checks the source path) — the team user is refused by Wiki.js ("Forbidden"),
  // no longer by the MCP's own pages.single lookup ("not authorized to view this page").
  const mv = await call('wiki_page_move', { id: pageId, destinationPath: MOVED_PATH }, token);
  check(
    'team: wiki_page_move reaches Wiki.js (refused only by its manage:pages move rule)',
    !/view this page/.test(mv.text) && (!mv.isError || /Forbidden|not authorized to move this page/.test(mv.text)),
    mv.text.slice(0, 200),
  );

  if (Number.isInteger(blockedId)) {
    const bh = await call('wiki_page_history', { id: blockedId }, token);
    check('team: guardrail refuses history of the blocked page', bh.isError && bh.text.includes('blocked tag'), bh.text.slice(0, 200));
    const bu = await call('wiki_page_update', { id: blockedId, content: 'x' }, token);
    check('team: guardrail refuses updating the blocked page', bu.isError && bu.text.includes('blocked tag'), bu.text.slice(0, 200));
  } else {
    check('team: blocked fixture page exists', false, 'geheim/ki-sperre-test not found');
  }
  const bg = await call('wiki_page_get', { path: 'geheim/ki-sperre-test', locale: 'en' }, token);
  check('team: guardrail refuses reading the blocked page by path', bg.isError && bg.text.includes('blocked tag'), bg.text.slice(0, 200));

  await admin.remove(TEAM_PATH);
  await admin.remove(MOVED_PATH);
}

async function main() {
  // ---- 0. wiki reachable through caddy ------------------------------------
  check('wiki reachable after finalize', await waitForWiki());

  // ---- 1. discovery --------------------------------------------------------
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check('AS metadata issuer matches PUBLIC_BASE_URL', as.issuer === BASE, as.issuer);
  const pr = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  check('PR metadata resource is /mcp', pr.resource === `${BASE}/mcp`, pr.resource);

  const unauth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  check('unauthenticated /mcp → 401', unauth.status === 401);
  check('WWW-Authenticate carries resource_metadata', (unauth.headers.get('www-authenticate') ?? '').includes('resource_metadata'));

  // ---- 2. DCR ---------------------------------------------------------------
  const reg = await (await fetch(`${BASE}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'E2E Test Client', redirect_uris: ['http://localhost:44444/cb'] }),
  })).json();
  check('DCR returns client_id', typeof reg.client_id === 'string' && reg.client_id.startsWith('mcp_client_'));

  // ---- 3. authorize (credentials mode, like a browser form post) -----------
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const authQuery = new URLSearchParams({
    client_id: reg.client_id, redirect_uri: 'http://localhost:44444/cb',
    response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e-state',
  });
  const { res: authPage, html: authHtml, nonceCookie, csrf } = await formPage(`${BASE}/oauth/authorize?${authQuery}`);
  check('authorize page renders login form', authPage.status === 200 && authHtml.includes('mode') && authHtml.includes('password'));
  check('authorize page names the client', authHtml.includes('E2E Test Client'));
  check('authorize page issues a CSRF nonce (cookie + hidden field)', nonceCookie !== '' && csrf !== '');

  const decisionBody = {
    client_id: reg.client_id, redirect_uri: 'http://localhost:44444/cb',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e-state',
    mode: 'credentials', action: 'allow', username: ADMIN.user, password: ADMIN.pass,
  };
  // A form planted on a wiki page has no nonce: same-origin, but refused.
  const forged = await fetch(`${BASE}/oauth/authorize/decision`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
    body: new URLSearchParams(decisionBody),
  });
  check('decision without the page nonce is refused (CSRF)', forged.status === 403, forged.status);

  const decision = await fetch(`${BASE}/oauth/authorize/decision`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie: nonceCookie },
    body: new URLSearchParams({ ...decisionBody, csrf }),
  });
  const loc = decision.headers.get('location') ?? '';
  check('decision 303-redirects to the client callback', decision.status === 303 && loc.startsWith('http://localhost:44444/cb?'), `${decision.status} ${loc}`);
  const cbUrl = new URL(loc);
  const code = cbUrl.searchParams.get('code') ?? '';
  check('redirect carries code + state', code.startsWith('mcp_ac_') && cbUrl.searchParams.get('state') === 'e2e-state');
  const meCookie = decision.headers.get('set-cookie') ?? '';
  check('decision sets the mcp_me cookie', meCookie.includes('mcp_me=') && meCookie.includes('HttpOnly'));

  // ---- 4. token exchange + PKCE --------------------------------------------
  const tokenRes = await fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: reg.client_id,
      redirect_uri: 'http://localhost:44444/cb', code_verifier: verifier,
    }),
  });
  const tokens = await tokenRes.json();
  check('token exchange succeeds', tokenRes.status === 200 && tokens.access_token?.startsWith('mcp_at_'), JSON.stringify(tokens));

  // ---- 5. MCP with the per-user session ------------------------------------
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }, tokens.access_token);
  check('MCP initialize with bearer succeeds', init.status === 200 && init.body?.result?.serverInfo?.name === 'mcp-wikijs-mv');
  await mcp('notifications/initialized', {}, tokens.access_token).catch(() => {});

  const profile = await call('wiki_user_profile', {}, tokens.access_token);
  check('tool call runs as the REAL wiki user (profile = admin)', !profile.isError && profile.text.includes(ADMIN.user), profile.text.slice(0, 200));

  const created = await call('wiki_page_create', {
    path: 'geheim/ki-sperre-test', title: 'Geheime Seite', content: 'Streng intern.',
    description: '', locale: 'en', tags: ['kein-ki'],
  }, tokens.access_token);
  check('page with kein-ki tag can be created', !created.isError || created.text.includes('already exists'), created.text.slice(0, 200));

  const openPage = await call('wiki_page_create', {
    path: 'public/offen', title: 'Offene Seite', content: 'Für alle.',
    description: '', locale: 'en', tags: [],
  }, tokens.access_token);
  check('normal page can be created', !openPage.isError, openPage.text.slice(0, 200));

  const blockedGet = await call('wiki_page_get', { path: 'geheim/ki-sperre-test', locale: 'en' }, tokens.access_token);
  check('guardrail refuses reading the blocked page', blockedGet.isError && blockedGet.text.includes('blocked tag'), blockedGet.text.slice(0, 200));

  const list = await call('wiki_pages_list', {}, tokens.access_token);
  check('list hides the blocked page + reports it', !list.text.includes('ki-sperre-test') && list.text.includes('hiddenByTagGuardrail'), list.text.slice(0, 300));

  const search = await call('wiki_pages_search', { query: 'Geheime' }, tokens.access_token);
  check('search does not return the blocked page', !search.isError && !search.text.includes('ki-sperre-test'), search.text.slice(0, 200));

  const tags = await call('wiki_tags_list', {}, tokens.access_token);
  const tagId = (tags.structured ?? []).find?.((t) => t.tag === 'kein-ki')?.id;
  check('tags list returns the kein-ki tag id', Number.isInteger(tagId), tags.text.slice(0, 200));
  if (Number.isInteger(tagId)) {
    const tagUpd = await call('wiki_tag_update', { id: tagId, tag: 'umbenannt', title: 'x', confirm: true }, tokens.access_token);
    check('guardrail tag cannot be renamed by the agent', tagUpd.isError && tagUpd.text.includes('protected AI-guardrail tag'), tagUpd.text.slice(0, 200));
  }

  const marker = 'MCP Asset Roundtrip OK';
  const up = await call('wiki_asset_upload', {
    filename: 'e2e-asset.csv',
    contentBase64: Buffer.from(marker).toString('base64'),
    folderId: 0,
    confirm: true,
  }, tokens.access_token);
  check('asset upload succeeds', !up.isError, up.text.slice(0, 150));
  const down = await call('wiki_asset_download', { path: 'e2e-asset.csv' }, tokens.access_token);
  check('asset download returns the uploaded content', !down.isError && down.text.includes(marker), down.text.slice(0, 150));
  // Oversize path: a 22-byte asset with maxBytes=1 must be rejected via the
  // Content-Length pre-check (AssetTooLargeError → "Raise maxBytes").
  const downCapped = await call('wiki_asset_download', { path: 'e2e-asset.csv', maxBytes: 1 }, tokens.access_token);
  check('asset download rejects over-limit before buffering', downCapped.isError && /over the .* limit|Raise maxBytes/.test(downCapped.text), downCapped.text.slice(0, 150));
  // Wiki.js reserves .md/.html/.txt as page extensions — the tool must explain that.
  const downTxt = await call('wiki_asset_download', { path: 'e2e-asset.txt' }, tokens.access_token);
  check('page-extension assets get the explanatory error', downTxt.isError && downTxt.text.includes('page extensions'), downTxt.text.slice(0, 150));

  const del = await call('wiki_page_delete', { path: 'public/offen', locale: 'en' }, tokens.access_token);
  check('delete without confirm returns dry-run preview', !del.isError && del.text.includes('DRY RUN'), del.text.slice(0, 200));
  const del2 = await call('wiki_page_delete', { path: 'public/offen', locale: 'en', confirm: true }, tokens.access_token);
  check('delete with confirm executes', !del2.isError && del2.text.includes('deleted'), del2.text.slice(0, 200));

  // ---- 5b. page tools as a NON-admin team user (audit A-01/A-28) -----------
  await teamUserPageTools(reg.client_id);

  // ---- 6. refresh rotation against the live server -------------------------
  const ref = await (await fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }),
  })).json();
  check('refresh grant rotates tokens', ref.access_token?.startsWith('mcp_at_') && ref.access_token !== tokens.access_token);
  const oldProfile = await call('wiki_user_profile', {}, tokens.access_token);
  check('old access token is dead after refresh', oldProfile.status === 401 || oldProfile.isError, `status=${oldProfile.status}`);

  // ---- 7. /me self-service --------------------------------------------------
  /** /me/login through the rendered login form (nonce cookie + field), like a browser. */
  const meLoginAs = async (user) => {
    const form = await formPage(`${BASE}/me`);
    return fetch(`${BASE}/me/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie: form.nonceCookie },
      body: new URLSearchParams({ username: user.user, password: user.pass, csrf: form.csrf }),
    });
  };
  const meLogin = await meLoginAs(ADMIN);
  const meCookie2 = meCookieOf(meLogin);
  check('/me/login sets session cookie', meLogin.status === 303 && /^(__Host-)?mcp_me=/.test(meCookie2));
  const meForm = await formPage(`${BASE}/me`, meCookie2);
  const mePage = meForm.html;
  check('/me lists the E2E client session', mePage.includes('E2E Test Client'));
  // Admin rendering gate: a wiki admin (admin@example.com) sees the team-wide
  // sessions + audit sections; the isWikiAdmin probe drives this.
  check(
    '/me shows the admin section for a wiki admin',
    mePage.includes('Alle aktiven KI-Verbindungen (Admin') && mePage.includes('Audit-Log (Admin'),
  );
  // Negative: a non-admin (Team group, no manage:users) must NOT see it.
  // Fixture: the demo user from bootstrap --demo.
  const nonAdminLogin = await meLoginAs(DEMO);
  const nonAdminCookie = meCookieOf(nonAdminLogin);
  const nonAdminPage = await (await fetch(`${BASE}/me`, { headers: { cookie: nonAdminCookie } })).text();
  check(
    '/me hides the admin section from a non-admin',
    nonAdminLogin.status === 303 && !nonAdminPage.includes('Audit-Log (Admin') && !nonAdminPage.includes('Alle aktiven KI-Verbindungen (Admin'),
  );
  const revokeCsrf = await fetch(`${BASE}/me/revoke`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example', cookie: meCookie2 },
    body: new URLSearchParams({ session_id: 'x' }),
  });
  check('cross-origin revoke is rejected (CSRF)', revokeCsrf.status === 403);

  const sessionId = (mePage.match(/name="session_id" value="([^"]+)"/) ?? [])[1];
  check('/me exposes the session id for revoke', typeof sessionId === 'string');
  if (sessionId) {
    await fetch(`${BASE}/me/revoke`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie: `${meCookie2}; ${meForm.nonceCookie}` },
      body: new URLSearchParams({ session_id: sessionId, csrf: meForm.csrf }),
    });
    const afterRevoke = await call('wiki_user_profile', {}, ref.access_token);
    check('revoked session loses MCP access immediately', afterRevoke.status === 401 || afterRevoke.isError, `status=${afterRevoke.status}`);
  }

  console.log(failed === 0 ? `\n${pass} E2E assertions passed.` : `\n${failed} FAILED (of ${pass + failed}).`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
