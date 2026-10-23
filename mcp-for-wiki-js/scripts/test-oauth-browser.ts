/**
 * Offline tests for the browser-facing OAuth routes against a stubbed Wiki.js
 * (global fetch): the authorize decision (credentials, 2FA, consent, deny),
 * /me/login, /me/logout and /me/revoke. Covers login rate limits (R-11), Fetch-Metadata
 * (R-17), the CSRF nonce of the consent and /me pages (proxy.ts), __Host- cookies (R-21), fixed error codes (R-22), no upstream
 * details in the browser (R-23), the bound 2FA continuation outside the URL
 * (R-26), the wiki user id as owner (R-41), `iss` on the deny redirect (R-48)
 * and the 2FA path end to end (R-53).
 * Run: npm run test:oauth-browser
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

import { createHash, randomBytes } from 'node:crypto';

process.env.MCP_SESSION_SECRET = 'test-secret-for-oauth-browser-0123456789';
process.env.PUBLIC_BASE_URL = 'http://mcp.test';
process.env.WIKIJS_URL = 'http://wiki.test';
delete process.env.MCP_ALLOWED_REDIRECT_HOSTS;

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

const ISSUER = 'http://mcp.test';

// ---- Wiki.js stub -------------------------------------------------------------
const wikiCalls: string[] = [];
function gql(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
}
const fail = (errorCode: number, message: string) => ({ responseResult: { succeeded: false, errorCode, message } });
const ok = (jwt: string) => ({ responseResult: { succeeded: true, errorCode: 0, message: 'Login success' }, jwt });

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: Record<string, string> };
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  const v = body.variables ?? {};
  if (body.query.includes('loginTFA(')) {
    wikiCalls.push(`tfa:${v.t}:${v.c}`);
    const r = v.t === 'CT-TINA' && v.c === '123456' ? ok('JWT_TINA') : fail(1005, 'Incorrect TFA Security Code.');
    return gql({ authentication: { loginTFA: r } });
  }
  if (body.query.includes('login(')) {
    wikiCalls.push(`login:${v.u}`);
    if (v.u === 'down') throw new TypeError('fetch failed');
    if (v.u === 'html') return new Response('<html>502 Bad Gateway nginx at 10.0.0.5</html>', { status: 502 });
    if (v.u === 'limited') {
      return new Response(JSON.stringify({ errors: [{ message: 'Too many requests, please try again in 42 seconds.' }] }), { status: 200 });
    }
    if (v.u === 'disabled') return gql({ authentication: { login: fail(1013, 'Your account has been disabled.') } });
    if (v.p !== 'right') return gql({ authentication: { login: fail(1002, 'Invalid email / username or password.') } });
    if (v.u === 'tina') {
      return gql({ authentication: { login: { responseResult: { succeeded: true, errorCode: 0, message: '' }, mustProvideTFA: true, continuationToken: 'CT-TINA' } } });
    }
    return gql({ authentication: { login: ok('JWT_ALICE') } });
  }
  if (body.query.includes('list {')) {
    // isWikiAdmin probe: nobody in this suite is a user manager.
    return new Response(JSON.stringify({ errors: [{ message: 'Forbidden' }] }), { status: 200 });
  }
  if (body.query.includes('profile')) {
    wikiCalls.push(`profile:${auth}`);
    if (auth === 'Bearer JWT_ALICE') return gql({ users: { profile: { id: 7, name: 'Alice', email: 'alice@example.org' } } });
    if (auth === 'Bearer JWT_TINA') return gql({ users: { profile: { id: 8, name: 'Tina', email: 'tina@example.org' } } });
    return new Response(JSON.stringify({ errors: [{ message: 'Forbidden' }] }), { status: 200 });
  }
  throw new Error(`unexpected wiki call: ${body.query}`);
}) as typeof fetch;

// ---- request helpers ------------------------------------------------------------
type Nav = 'user' | 'script-fetch' | 'script-submit' | 'cross-site' | 'legacy';
const SEC_FETCH: Record<Nav, Record<string, string>> = {
  user: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1', 'sec-fetch-dest': 'document' },
  'script-fetch': { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
  'script-submit': { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  'cross-site': { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1', 'sec-fetch-dest': 'document' },
  legacy: {},
};

// Decision and /me posts carry the nonce of a rendered consent or /me page (cookie +
// field) unless a test opts out with `nonce: false`; set once the web module is loaded in main().
let web: typeof import('../lib/oauth/web');

let ipCounter = 1;
const freshIp = () => `192.0.2.${ipCounter++}`;

function post(
  path: string,
  fields: Record<string, string>,
  o: { nav?: Nav; cookie?: string; ip?: string; https?: boolean; origin?: string; nonce?: false } = {},
): Request {
  let cookie = o.cookie;
  const scope =
    path === '/oauth/authorize/decision'
      ? { clientId: fields.client_id ?? '', codeChallenge: fields.code_challenge ?? '' }
      : path.startsWith('/me/')
        ? ('me' as const)
        : undefined;
  if (scope && o.nonce !== false) {
    const minted = web.issueConsentNonce(scope, Boolean(o.https));
    fields = { ...fields, csrf: minted.nonce };
    cookie = [cookie, minted.cookie.split(';')[0]].filter(Boolean).join('; ');
  }
  return new Request(`${o.https ? 'https' : 'http'}://mcp.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: o.origin ?? ISSUER,
      'x-forwarded-for': o.ip ?? freshIp(),
      ...(o.https ? { 'x-forwarded-proto': 'https' } : {}),
      ...(cookie ? { cookie } : {}),
      ...SEC_FETCH[o.nav ?? 'user'],
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const location = (r: Response) => r.headers.get('location') ?? '';
const query = (r: Response) => new URL(location(r), ISSUER).searchParams;
const setCookies = (r: Response) => r.headers.getSetCookie();
const cookiePair = (setCookie: string) => setCookie.split(';')[0];

async function main(): Promise<void> {
  const store = await import('../lib/oauth/store');
  const service = await import('../lib/oauth/service');
  const crypto = await import('../lib/oauth/crypto');
  web = await import('../lib/oauth/web');
  const { clientIp } = await import('../lib/oauth/rate-limit');
  const { loginErrorText } = await import('../lib/oauth/messages');
  const decision = await import('../app/oauth/authorize/decision/route');
  const meLogin = await import('../app/me/login/route');
  const meLogout = await import('../app/me/logout/route');
  store.openTestStore();

  const reg = service.registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  const other = service.registerClient({ client_name: 'Other', redirect_uris: ['https://other.example/cb'] });
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const authz = {
    client_id: reg.client_id,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st',
  };
  const creds = (username: string, password = 'wrong') => ({ ...authz, mode: 'credentials', action: 'allow', username, password });

  // ---- R-17: only a user's click (top-level navigation) may decide ------------------
  const deny = { ...authz, mode: 'credentials', action: 'deny' };
  check('R-17: script fetch() from the same origin → 403', (await decision.POST(post('/oauth/authorize/decision', deny, { nav: 'script-fetch' }))).status === 403);
  check('R-17: script form.submit() without user activation → 403', (await decision.POST(post('/oauth/authorize/decision', deny, { nav: 'script-submit' }))).status === 403);
  check('R-17: cross-site navigation → 403', (await decision.POST(post('/oauth/authorize/decision', deny, { nav: 'cross-site' }))).status === 403);
  const legacyDeny = await decision.POST(post('/oauth/authorize/decision', deny, { nav: 'legacy' }));
  check('R-17: browser without Fetch Metadata (Origin check only) is still served', legacyDeny.status === 303);
  const userDeny = await decision.POST(post('/oauth/authorize/decision', deny));
  check('deny → 303 to the client with error=access_denied', userDeny.status === 303 && location(userDeny).startsWith(authz.redirect_uri) && query(userDeny).get('error') === 'access_denied');
  check('R-48: deny redirect carries iss', query(userDeny).get('iss') === ISSUER);
  // Under a no-referrer policy (next.config.js used to send one) browsers serialize the
  // Origin of a form POST as "null" (verified in Chromium). Sec-Fetch-Site decides.
  const nullOrigin = await decision.POST(post('/oauth/authorize/decision', deny, { origin: 'null' }));
  check('CSRF: Origin "null" (no-referrer policy) + Sec-Fetch-Site same-origin → accepted', nullOrigin.status === 303);
  check('CSRF: Origin "null" without Fetch Metadata → 403 (fail closed)', (await decision.POST(post('/oauth/authorize/decision', deny, { origin: 'null', nav: 'legacy' }))).status === 403);
  check('CSRF: Origin "null" from a cross-site navigation → 403', (await decision.POST(post('/oauth/authorize/decision', deny, { origin: 'null', nav: 'cross-site' }))).status === 403);
  const meNull = await meLogin.POST(post('/me/login', { username: 'carol', password: 'right' }, { origin: 'null' }));
  check('CSRF: /me/login with Origin "null" + same-origin Fetch Metadata works', meNull.status === 303 && location(meNull) === `${ISSUER}/me`);

  // ---- consent CSRF nonce: a same-origin <form> in a wiki page must not decide ---------
  // Wiki.js keeps <form method=post action=/oauth/authorize/decision> + hidden fields in
  // page content; a reader's click carries same-origin Origin and Sec-Fetch-User ?1.
  const aliceWiki = 'jwt=JWT_ALICE';
  for (const [mode, fields] of [
    ['consent', { ...authz, mode: 'consent', action: 'allow' }],
    ['credentials', creds('alice', 'right')],
    ['tfa', { ...authz, mode: 'tfa', action: 'allow', security_code: '123456' }],
    ['deny', { ...authz, mode: 'consent', action: 'deny' }],
  ] as const) {
    const r = await decision.POST(post('/oauth/authorize/decision', fields, { cookie: aliceWiki, nonce: false }));
    check(`CSRF nonce: ${mode} without the nonce of a rendered consent page → 403`, r.status === 403 && !location(r));
  }
  const forged = await decision.POST(
    post('/oauth/authorize/decision', { ...authz, mode: 'consent', action: 'allow', csrf: 'guessed' }, { cookie: `${aliceWiki}; mcp_csrf=guessed`, nonce: false }),
  );
  check('CSRF nonce: a made-up nonce (field + cookie) → 403', forged.status === 403);

  // The proxy mints the nonce when the consent page is rendered.
  const { proxy } = await import('../proxy');
  const { NextRequest } = await import('next/server');
  const render = (q: Record<string, string>, h: Record<string, string> = {}) =>
    proxy(new NextRequest(`${ISSUER}/oauth/authorize?${new URLSearchParams({ ...q, response_type: 'code' })}`, { headers: h }));
  const page = render(authz, { [web.CONSENT_NONCE_HEADER]: 'chosen-by-client' });
  const pageCookie = page.headers.getSetCookie().find((c) => c.startsWith('mcp_csrf=')) ?? '';
  const pageNonce = page.headers.get(`x-middleware-request-${web.CONSENT_NONCE_HEADER}`) ?? '';
  check('CSRF nonce: rendering /oauth/authorize sets an HttpOnly SameSite=Strict nonce cookie (10 min)',
    /HttpOnly/i.test(pageCookie) && /SameSite=Strict/i.test(pageCookie) && /Max-Age=600/.test(pageCookie) && /Path=\//.test(pageCookie));
  check('CSRF nonce: … and hands a fresh nonce to the page (a client-sent header is overwritten)', pageNonce.length >= 43 && pageNonce !== 'chosen-by-client');
  check('CSRF nonce: the cookie does not contain the nonce in clear', !pageCookie.includes(pageNonce));
  const consentWith = (nonce: string, cookie: string, extra: Record<string, string> = {}) =>
    decision.POST(post('/oauth/authorize/decision', { ...authz, mode: 'consent', action: 'allow', csrf: nonce, ...extra }, { cookie: `${aliceWiki}; ${cookiePair(cookie)}`, nonce: false }));
  const viaPage = await consentWith(pageNonce, pageCookie);
  check('CSRF nonce: consent with the rendered page’s nonce → 303 with a code (as before)', viaPage.status === 303 && query(viaPage).get('code')?.startsWith('mcp_ac_') === true);
  check('CSRF nonce: right cookie, wrong field → 403', (await consentWith('x'.repeat(43), pageCookie)).status === 403);
  const otherPage = render({ ...authz, client_id: other.client_id, redirect_uri: 'https://other.example/cb' });
  const otherNonce = otherPage.headers.get(`x-middleware-request-${web.CONSENT_NONCE_HEADER}`) ?? '';
  const otherCookie = otherPage.headers.getSetCookie().find((c) => c.startsWith('mcp_csrf=')) ?? '';
  check('CSRF nonce: a nonce rendered for another client does not authorize this one → 403', (await consentWith(otherNonce, otherCookie)).status === 403);
  check('CSRF nonce: … nor for another PKCE challenge → 403', (await consentWith(pageNonce, pageCookie, { code_challenge: 'B'.repeat(43) })).status === 403);
  const stale = web.issueConsentNonce({ clientId: authz.client_id, codeChallenge: authz.code_challenge }, false, Date.now() - 11 * 60_000);
  check('CSRF nonce: a nonce older than 10 minutes → 403', (await consentWith(stale.nonce, stale.cookie)).status === 403);
  const tlsNonce = web.issueConsentNonce({ clientId: authz.client_id, codeChallenge: authz.code_challenge }, true);
  check('CSRF nonce: over TLS the cookie is __Host-mcp_csrf (Secure)', tlsNonce.cookie.startsWith('__Host-mcp_csrf=') && /;\s*Secure/i.test(tlsNonce.cookie));

  // ---- R-22 / R-23: fixed codes, nothing from upstream in the browser ---------------
  const wrong = await decision.POST(post('/oauth/authorize/decision', creds('alice')));
  check('R-22: wrong password → back to authorize with a fixed code', query(wrong).get('login_error') === 'invalid_credentials');
  const down = await decision.POST(post('/oauth/authorize/decision', creds('down')));
  check('R-23: wiki unreachable → code "unavailable"', query(down).get('login_error') === 'unavailable');
  check('R-23: … the redirect does not name the internal wiki endpoint', !/wiki\.test|graphql/.test(location(down)));
  const html = await decision.POST(post('/oauth/authorize/decision', creds('html')));
  check('R-23: HTML error page from upstream → generic code, no HTML fragment', ['unavailable', 'failed'].includes(query(html).get('login_error') ?? '') && !/Gateway|nginx|10\.0\.0\.5/.test(decodeURIComponent(location(html))));
  const disabled = await decision.POST(post('/oauth/authorize/decision', creds('disabled', 'right')));
  check('R-22: disabled account → code "account_disabled"', query(disabled).get('login_error') === 'account_disabled');
  const limited = await decision.POST(post('/oauth/authorize/decision', creds('limited', 'right')));
  check('R-22: Wiki.js rate limit → code "rate_limited"', query(limited).get('login_error') === 'rate_limited');
  check('R-22: every code has a German text', ['invalid_credentials', 'unavailable', 'failed', 'account_disabled', 'rate_limited', 'tfa_failed', 'tfa_expired', 'session_expired', 'me_tfa'].every((c) => typeof loginErrorText(c) === 'string'));
  check('R-22: free text in login_error renders nothing', loginErrorText('<b>Phishing: call +49…</b>') === undefined);

  // ---- R-11: own login limiter (per IP and per username) ----------------------------
  const ip = freshIp();
  for (let i = 0; i < 10; i++) await decision.POST(post('/oauth/authorize/decision', creds(`user${i}`), { ip }));
  const callsBefore = wikiCalls.length;
  const ipBlocked = await decision.POST(post('/oauth/authorize/decision', creds('alice', 'right'), { ip }));
  check('R-11: 11th login from one IP within 15 min → rate_limited', query(ipBlocked).get('login_error') === 'rate_limited');
  check('R-11: … without calling Wiki.js (its shared 5/min bucket stays free)', wikiCalls.length === callsBefore);
  for (let i = 0; i < 5; i++) await decision.POST(post('/oauth/authorize/decision', creds('Bob')));
  const userBlocked = await decision.POST(post('/oauth/authorize/decision', creds('bob')));
  check('R-11: 6th attempt for one username (any IP, any case) → rate_limited', query(userBlocked).get('login_error') === 'rate_limited');
  const meBlocked = await meLogin.POST(post('/me/login', { username: 'bob', password: 'x' }));
  check('R-11: /me/login shares the per-user limit', query(meBlocked).get('login_error') === 'rate_limited');
  check('R-11: client IP = right-most X-Forwarded-For hop (set by our proxy)', clientIp(new Headers({ 'x-forwarded-for': '6.6.6.6, 198.51.100.9' })) === '198.51.100.9');

  // ---- success + R-21 cookies --------------------------------------------------------
  const okHttps = await decision.POST(post('/oauth/authorize/decision', creds('alice', 'right'), { https: true }));
  check('credentials → 303 to the client with a code', location(okHttps).startsWith(authz.redirect_uri) && query(okHttps).get('code')?.startsWith('mcp_ac_') === true);
  check('R-48: code redirect carries iss', query(okHttps).get('iss') === ISSUER);
  const secureCookie = setCookies(okHttps).find((c) => c.includes('mcp_me=')) ?? '';
  check('R-21: over TLS the cookie is __Host-mcp_me (Secure, Path=/, no Domain)',
    secureCookie.startsWith('__Host-mcp_me=') && /;\s*Secure/i.test(secureCookie) && /Path=\//.test(secureCookie) && !/Domain=/i.test(secureCookie));
  const tokens = service.exchangeAuthorizationCode({ code: query(okHttps).get('code')!, clientId: reg.client_id, redirectUri: authz.redirect_uri, codeVerifier: verifier });
  check('R-41: the session belongs to the wiki user id from the profile', store.getSessionByAccessHash(crypto.sha256hex(tokens.access_token))?.userId === 7);

  const okHttp = await decision.POST(post('/oauth/authorize/decision', creds('alice', 'right')));
  const plainCookie = setCookies(okHttp).find((c) => c.includes('mcp_me=')) ?? '';
  check('R-21: plain-HTTP local test keeps the bare name (browsers refuse __Host- without TLS)', plainCookie.startsWith('mcp_me=') && !/Secure/i.test(plainCookie));

  const jar = (pairs: string[]) => {
    const m = new Map(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as [string, string]));
    return { get: (n: string) => (m.has(n) ? { value: m.get(n)! } : undefined) };
  };
  const meValue = cookiePair(secureCookie).slice('__Host-mcp_me='.length);
  check('R-21: on TLS the __Host- cookie identifies the user', (await web.identityFromCookies(jar([`__Host-mcp_me=${meValue}`]), true))?.identity.id === 7);
  check('R-21: on TLS a bare mcp_me cookie (e.g. tossed from a subdomain) is ignored', (await web.identityFromCookies(jar([`mcp_me=${meValue}`]), true)) === undefined);

  const logout = await meLogout.POST(post('/me/logout', {}, { https: true }));
  check('R-21: logout over TLS clears __Host-mcp_me', setCookies(logout).some((c) => c.startsWith('__Host-mcp_me=;') && /Max-Age=0/.test(c)));

  // ---- R-26 / R-53: 2FA, continuation bound and outside the URL ---------------------
  const step1 = await decision.POST(post('/oauth/authorize/decision', creds('tina', 'right')));
  const tfaSet = setCookies(step1).find((c) => c.startsWith('mcp_tfa=')) ?? '';
  check('R-53: 2FA account → back to authorize in the 2FA step', query(step1).get('step') === 'tfa' && new URL(location(step1), ISSUER).pathname === '/oauth/authorize');
  check('R-26: the continuation is NOT in the URL', !query(step1).has('tfa') && !location(step1).includes(cookiePair(tfaSet).slice('mcp_tfa='.length)));
  check('R-26: … but in a short-lived HttpOnly SameSite=Strict cookie', /HttpOnly/i.test(tfaSet) && /SameSite=Strict/i.test(tfaSet) && /Max-Age=300/.test(tfaSet));
  const tfaCookie = cookiePair(tfaSet);

  const tfaForm = (extra: Record<string, string> = {}) => ({ ...authz, mode: 'tfa', action: 'allow', security_code: '123456', ...extra });
  const otherClient = await decision.POST(post('/oauth/authorize/decision', { ...tfaForm(), client_id: other.client_id, redirect_uri: 'https://other.example/cb' }, { cookie: tfaCookie }));
  check('R-26: continuation is bound to the client it was issued for', query(otherClient).get('login_error') === 'tfa_expired');
  const otherChallenge = await decision.POST(post('/oauth/authorize/decision', tfaForm({ code_challenge: 'A'.repeat(43) }), { cookie: tfaCookie }));
  check('R-26: … and to the PKCE challenge of the request', query(otherChallenge).get('login_error') === 'tfa_expired');
  const noCookie = await decision.POST(post('/oauth/authorize/decision', tfaForm()));
  check('R-26: 2FA step without the cookie → tfa_expired', query(noCookie).get('login_error') === 'tfa_expired');
  const expired = crypto.encryptString(
    JSON.stringify({ t: 'CT-TINA', cid: reg.client_id, ch: challenge, exp: Date.now() - 1000 }),
    'tfa',
  );
  const expiredRes = await decision.POST(post('/oauth/authorize/decision', tfaForm(), { cookie: `mcp_tfa=${expired}` }));
  check('R-26: expired continuation → tfa_expired', query(expiredRes).get('login_error') === 'tfa_expired');
  check('R-26: none of the rejected continuations reached Wiki.js', !wikiCalls.some((c) => c.startsWith('tfa:')));

  const wrongCode = await decision.POST(post('/oauth/authorize/decision', tfaForm({ security_code: '000000' }), { cookie: tfaCookie }));
  check('R-53: wrong 2FA code → tfa_failed (Wiki.js consumed the continuation)', query(wrongCode).get('login_error') === 'tfa_failed');
  check('R-53: … and the continuation cookie is cleared', setCookies(wrongCode).some((c) => c.startsWith('mcp_tfa=;') && /Max-Age=0/.test(c)));

  const step1b = await decision.POST(post('/oauth/authorize/decision', creds('tina', 'right')));
  const tfaCookie2 = cookiePair(setCookies(step1b).find((c) => c.startsWith('mcp_tfa='))!);
  const done = await decision.POST(post('/oauth/authorize/decision', tfaForm(), { cookie: tfaCookie2 }));
  check('R-53: right 2FA code → 303 to the client with a code', location(done).startsWith(authz.redirect_uri) && query(done).get('code')?.startsWith('mcp_ac_') === true);
  check('R-53: … continuation cookie cleared, mcp_me set', setCookies(done).some((c) => c.startsWith('mcp_tfa=;')) && setCookies(done).some((c) => c.startsWith('mcp_me=')));
  const tinaTokens = service.exchangeAuthorizationCode({ code: query(done).get('code')!, clientId: reg.client_id, redirectUri: authz.redirect_uri, codeVerifier: verifier });
  check('R-53: the 2FA login yields a session for the 2FA user', store.getSessionByAccessHash(crypto.sha256hex(tinaTokens.access_token))?.userId === 8);

  // ---- /me/login ------------------------------------------------------------------------
  const meTfa = await meLogin.POST(post('/me/login', { username: 'tina', password: 'right' }));
  check('R-22: /me with a 2FA account → fixed code me_tfa', query(meTfa).get('login_error') === 'me_tfa');
  const meOk = await meLogin.POST(post('/me/login', { username: 'alice', password: 'right' }));
  check('/me/login success → 303 /me with mcp_me', location(meOk) === `${ISSUER}/me` && setCookies(meOk).some((c) => c.startsWith('mcp_me=')));

  // ---- R-41: /me/revoke decides ownership by wiki user id -----------------------------
  const meRevoke = await import('../app/me/revoke/route');
  const row = (id: string, userId: number | null) => ({
    id, accessHash: `a-${id}`, refreshHash: `r-${id}`, clientId: reg.client_id, clientName: 'X', userLabel: 'Someone',
    userEmail: 'alice@example.org', userId, encJwt: 'enc', accessExpiresAt: Date.now() + 3600_000,
    createdAt: Date.now(), lastUsedAt: Date.now(), revokedAt: null,
  });
  store.insertSession(row('same-email-other-account', 99));
  store.insertSession(row('legacy-no-id', null));
  const aliceCookie = `mcp_me=${web.meCookieValue('JWT_ALICE')}`;
  await meRevoke.POST(post('/me/revoke', { session_id: 'same-email-other-account' }, { cookie: aliceCookie }));
  check('R-41: a session of another wiki account with the same email cannot be revoked', store.getSessionById('same-email-other-account')?.revokedAt === null);
  await meRevoke.POST(post('/me/revoke', { session_id: 'legacy-no-id' }, { cookie: aliceCookie }));
  check('R-41: a legacy row without user id still belongs to its email owner', store.getSessionById('legacy-no-id')?.revokedAt != null);

  // ---- /me CSRF nonce: a same-origin <form> in a wiki page must not post to /me ---------
  // Same attack as on the consent page: Wiki.js keeps <form method=post action=/me/…>.
  store.insertSession(row('alice-own', 7));
  const meCalls = wikiCalls.length;
  const noNonceLogin = await meLogin.POST(post('/me/login', { username: 'alice', password: 'right' }, { nonce: false }));
  check('/me CSRF: /me/login without the nonce of a rendered /me page → 403, no cookie',
    noNonceLogin.status === 403 && setCookies(noNonceLogin).length === 0 && !location(noNonceLogin));
  check('/me CSRF: … and Wiki.js was not asked (no login attempt counted)', wikiCalls.length === meCalls);
  const noNonceLogout = await meLogout.POST(post('/me/logout', {}, { cookie: aliceCookie, nonce: false }));
  check('/me CSRF: /me/logout without the nonce → 403, cookie not cleared', noNonceLogout.status === 403 && setCookies(noNonceLogout).length === 0);
  const noNonceRevoke = await meRevoke.POST(post('/me/revoke', { session_id: 'alice-own' }, { cookie: aliceCookie, nonce: false }));
  check('/me CSRF: /me/revoke without the nonce → 403, session stays active',
    noNonceRevoke.status === 403 && store.getSessionById('alice-own')?.revokedAt === null);
  const forgedMe = await meRevoke.POST(
    post('/me/revoke', { session_id: 'alice-own', csrf: 'guessed' }, { cookie: `${aliceCookie}; mcp_csrf_me=guessed`, nonce: false }),
  );
  check('/me CSRF: a made-up nonce (field + cookie) → 403', forgedMe.status === 403 && store.getSessionById('alice-own')?.revokedAt === null);
  const consentMinted = web.issueConsentNonce({ clientId: authz.client_id, codeChallenge: authz.code_challenge }, false);
  const crossPurpose = await meRevoke.POST(post('/me/revoke', { session_id: 'alice-own', csrf: consentMinted.nonce },
    { cookie: `${aliceCookie}; ${cookiePair(consentMinted.cookie)}`, nonce: false }));
  check('/me CSRF: the consent page’s nonce does not authorize /me → 403', crossPurpose.status === 403);
  const meMinted = web.issueConsentNonce('me', false);
  const meAsConsent = await decision.POST(post('/oauth/authorize/decision', { ...authz, mode: 'consent', action: 'allow', csrf: meMinted.nonce },
    { cookie: `${aliceWiki}; ${cookiePair(meMinted.cookie)}`, nonce: false }));
  check('/me CSRF: … nor does the /me nonce authorize a consent → 403', meAsConsent.status === 403);
  const staleMe = web.issueConsentNonce('me', false, Date.now() - 11 * 60_000);
  const staleRevoke = await meRevoke.POST(post('/me/revoke', { session_id: 'alice-own', csrf: staleMe.nonce },
    { cookie: `${aliceCookie}; ${cookiePair(staleMe.cookie)}`, nonce: false }));
  check('/me CSRF: a /me nonce older than 10 minutes → 403', staleRevoke.status === 403);
  const tlsMe = web.issueConsentNonce('me', true);
  check('/me CSRF: over TLS the cookie is __Host-mcp_csrf_me (Secure, SameSite=Strict)',
    tlsMe.cookie.startsWith('__Host-mcp_csrf_me=') && /;\s*Secure/i.test(tlsMe.cookie) && /SameSite=Strict/i.test(tlsMe.cookie));

  // The proxy mints the /me nonce when /me is rendered.
  const { config: proxyConfig } = await import('../proxy');
  check('/me CSRF: the proxy runs for /me (and still for /oauth/authorize)',
    [proxyConfig.matcher].flat().includes('/me') && [proxyConfig.matcher].flat().includes('/oauth/authorize'));
  const mePage = proxy(new NextRequest(`${ISSUER}/me`, { headers: { [web.CONSENT_NONCE_HEADER]: 'chosen-by-client' } }));
  const mePageCookie = mePage.headers.getSetCookie().find((c) => c.startsWith('mcp_csrf_me=')) ?? '';
  const mePageNonce = mePage.headers.get(`x-middleware-request-${web.CONSENT_NONCE_HEADER}`) ?? '';
  check('/me CSRF: rendering /me sets an HttpOnly SameSite=Strict nonce cookie and hands a fresh nonce to the page',
    /HttpOnly/i.test(mePageCookie) && /SameSite=Strict/i.test(mePageCookie) && mePageNonce.length >= 43 && mePageNonce !== 'chosen-by-client');
  const viaMePage = await meRevoke.POST(post('/me/revoke', { session_id: 'alice-own', csrf: mePageNonce },
    { cookie: `${aliceCookie}; ${cookiePair(mePageCookie)}`, nonce: false }));
  check('/me CSRF: revoke with the rendered /me page’s nonce → 303, session revoked (as before)',
    viaMePage.status === 303 && store.getSessionById('alice-own')?.revokedAt != null);
  const meLoginViaPage = await meLogin.POST(post('/me/login', { username: 'alice', password: 'right', csrf: mePageNonce },
    { cookie: cookiePair(mePageCookie), nonce: false }));
  check('/me CSRF: … the same page nonce serves the login form too', meLoginViaPage.status === 303 && setCookies(meLoginViaPage).some((c) => c.startsWith('mcp_me=')));
  const meLogoutViaPage = await meLogout.POST(post('/me/logout', { csrf: mePageNonce }, { cookie: `${aliceCookie}; ${cookiePair(mePageCookie)}`, nonce: false }));
  check('/me CSRF: … and the logout form', meLogoutViaPage.status === 303 && setCookies(meLogoutViaPage).some((c) => c.startsWith('mcp_me=;')));

  // ---- R-11 refinements: only failures count, running windows are never evicted -------
  const natIp = freshIp();
  let natAllIn = true;
  for (let i = 0; i < 12; i++) {
    const r = await decision.POST(post('/oauth/authorize/decision', creds(`colleague${i}`, 'right'), { ip: natIp }));
    if (!query(r).get('code')) natAllIn = false;
  }
  check('R-11: successful logins do not count — 12 people behind one NAT address all get in', natAllIn);

  for (let i = 0; i < 4; i++) await decision.POST(post('/oauth/authorize/decision', creds('dave')));
  await decision.POST(post('/oauth/authorize/decision', creds('dave', 'right')));
  for (let i = 0; i < 4; i++) await decision.POST(post('/oauth/authorize/decision', creds('dave')));
  const daveOk = await decision.POST(post('/oauth/authorize/decision', creds('dave', 'right')));
  check('R-11: a successful login clears the account counter (4 + ok + 4 failures, then ok)', query(daveOk).get('code') !== null);

  const lockedIp = freshIp();
  for (let i = 0; i < 10; i++) await decision.POST(post('/oauth/authorize/decision', creds(`spray${i}`), { ip: lockedIp }));
  for (let i = 0; i < 6; i++) await decision.POST(post('/oauth/authorize/decision', creds('erin'), { ip: lockedIp }));
  const erinOk = await decision.POST(post('/oauth/authorize/decision', creds('erin', 'right')));
  check('R-11: attempts refused for a locked IP do not count against the account', query(erinOk).get('code') !== null);

  const downCodes: string[] = [];
  for (let i = 0; i < 6; i++) downCodes.push(query(await decision.POST(post('/oauth/authorize/decision', creds('down')))).get('login_error') ?? '');
  check('R-11: an unreachable wiki does not lock the account (6× unavailable, never rate_limited)', downCodes.every((c) => c === 'unavailable'));

  const tinaSteps: string[] = [];
  for (let i = 0; i < 6; i++) tinaSteps.push(query(await decision.POST(post('/oauth/authorize/decision', creds('tina', 'right')))).get('step') ?? '');
  check('R-11: a right password of a 2FA account is no failure (6× to the 2FA step)', tinaSteps.every((s) => s === 'tfa'));
  for (let i = 0; i < 5; i++) {
    const s = await decision.POST(post('/oauth/authorize/decision', creds('tina', 'right')));
    const c = cookiePair(setCookies(s).find((x) => x.startsWith('mcp_tfa='))!);
    await decision.POST(post('/oauth/authorize/decision', tfaForm({ security_code: '000000' }), { cookie: c }));
  }
  const tinaLocked = await decision.POST(post('/oauth/authorize/decision', creds('tina', 'right')));
  check('R-11: wrong 2FA codes count against the account (5 → locked, from any IP)', query(tinaLocked).get('login_error') === 'rate_limited');

  const burstIp = freshIp();
  const burstBefore = wikiCalls.length;
  await Promise.all(Array.from({ length: 12 }, (_, i) => decision.POST(post('/oauth/authorize/decision', creds(`burst${i}`), { ip: burstIp }))));
  check('R-11: 12 parallel failures from one IP — at most 10 reach Wiki.js (attempts are reserved before the call)', wikiCalls.length - burstBefore <= 10);

  // ---- A-04: oversized usernames never reach Wiki.js or the limiter ---------------
  const longName = 'x'.repeat(257);
  const before = wikiCalls.length;
  const longDecision = await decision.POST(post('/oauth/authorize/decision', creds(longName), { ip: freshIp() }));
  check('A-04: decision with a 257-char username → invalid_credentials, no Wiki.js call', query(longDecision).get('login_error') === 'invalid_credentials' && wikiCalls.length === before);
  const longMe = await meLogin.POST(post('/me/login', { username: longName, password: 'x' }, { ip: freshIp() }));
  check('A-04: /me/login with a 257-char username → invalid_credentials, no Wiki.js call', query(longMe).get('login_error') === 'invalid_credentials' && wikiCalls.length === before);
  await decision.POST(post('/oauth/authorize/decision', creds('y'.repeat(256)), { ip: freshIp() }));
  check('A-04: a 256-char username is still tried', wikiCalls.length === before + 1);
  const { limiterUserKey, MAX_USERNAME_LENGTH } = await import('../lib/oauth/rate-limit');
  check('A-04: limiter keys are fixed-size hashes', limiterUserKey('z'.repeat(MAX_USERNAME_LENGTH)).length === 64 && limiterUserKey(' Ab ') === limiterUserKey('ab'));

  const { RateLimiter } = await import('../lib/oauth/rate-limit');
  const rl = new RateLimiter(1, 60_000, 2);
  rl.hit('victim', 0);
  rl.hit('victim', 0);
  rl.hit('junk1', 0);
  rl.hit('junk2', 0);
  check('R-11: a flood of new keys does not evict a running lockout', rl.hit('victim', 1) > 0);
  rl.hit('later', 60_001);
  check('R-11: expired windows still make room for new keys', rl.hit('later', 60_002) > 0);

  store.closeStore();
  if (failed === 0) {
    console.log(`\n${pass} oauth-browser assertions passed.`);
  } else {
    console.error(`\n${failed} oauth-browser assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
