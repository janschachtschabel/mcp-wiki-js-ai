/**
 * Shared helpers for the two browser-facing pages (/oauth/authorize and /me).
 *
 * Identity sources, in order:
 *   1. The wiki's own `jwt` cookie — present when the user is logged into
 *      Wiki.js in this browser AND the MCP server is served from the SAME host
 *      (the docker-compose appliance routes both through one domain). This is
 *      the zero-typing SSO path.
 *   2. Our own `mcp_me` cookie — set after a credentials login on /me or
 *      /oauth/authorize, holds the wiki JWT encrypted with the server secret.
 *   3. A username/password form (validated against Wiki.js' login mutation).
 */

import { randomBytes } from 'node:crypto';
import { decryptString, encryptString, safeEqual } from './crypto';
import { fetchIdentity, type WikiIdentity } from './wiki-login';
import { WikiClient } from '../wikijs/client';

/** Matches Wiki.js' default tokenExpiration (30m) — the cookie is only a convenience. */
export const ME_COOKIE_MAX_AGE_S = 30 * 60;
/** The 2FA step must follow the password step within this time (R-26). */
const TFA_MAX_AGE_S = 5 * 60;
/** A rendered consent or /me page stays usable this long. */
const CONSENT_NONCE_MAX_AGE_S = 10 * 60;

export function wikiBaseUrl(): string {
  const url = (process.env.WIKIJS_URL || process.env.WIKIJS_BASE_URL || '').trim();
  if (!url) throw new Error('WIKIJS_URL is not configured on the server.');
  return url;
}

export interface BrowserIdentity {
  identity: WikiIdentity;
  jwt: string;
  source: 'wiki-cookie' | 'me-cookie';
}

interface CookieJar {
  get(name: string): { value: string } | undefined;
}

/**
 * Over TLS our cookies carry the `__Host-` prefix: the browser then only
 * accepts them from exactly this origin (Secure, Path=/, no Domain), so a
 * sibling subdomain cannot plant one (R-21). Browsers refuse `__Host-` without
 * TLS, so a plain-HTTP local test uses the bare name.
 */
type CookieBase = 'mcp_me' | 'mcp_tfa' | 'mcp_csrf' | 'mcp_csrf_me';

function cookieName(base: CookieBase, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

function setCookie(base: CookieBase, value: string, maxAge: number, secure: boolean, sameSite: 'Lax' | 'Strict'): string {
  return `${cookieName(base, secure)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=${sameSite}` + (secure ? '; Secure' : '');
}

/** Cookies of a route-handler Request, in the shape of next/headers' cookies(). */
export function requestCookies(req: Request): CookieJar {
  const jar = new Map<string, string>();
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return { get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined) };
}

/**
 * Try to identify the browser user from cookies (no credentials involved).
 * Every JWT is validated against Wiki.js before it is trusted.
 */
export async function identityFromCookies(cookies: CookieJar, secure: boolean): Promise<BrowserIdentity | undefined> {
  const wikiJwt = cookies.get('jwt')?.value;
  if (wikiJwt) {
    const identity = await fetchIdentity(wikiBaseUrl(), wikiJwt);
    // Wiki.js sets the guest cookie too — a valid profile with an email is a real user.
    if (identity && identity.email && identity.email !== 'guest@example.com') {
      return { identity, jwt: wikiJwt, source: 'wiki-cookie' };
    }
  }
  const me = cookies.get(cookieName('mcp_me', secure))?.value;
  const jwt = me ? meCookieJwt(me) : undefined;
  if (jwt) {
    const identity = await fetchIdentity(wikiBaseUrl(), jwt);
    if (identity) return { identity, jwt, source: 'me-cookie' };
  }
  return undefined;
}

/**
 * Serialized Set-Cookie value for our own session cookie: {jwt, iat} under the
 * cookie-only key, so neither a DB ciphertext nor an old cookie replays (R-02).
 */
export function meCookieValue(jwt: string, iat: number = Math.floor(Date.now() / 1000)): string {
  return encryptString(JSON.stringify({ jwt, iat }), 'cookie');
}

/** The wiki JWT from an mcp_me cookie, or undefined if foreign, tampered or past max-age. */
export function meCookieJwt(value: string, now: number = Math.floor(Date.now() / 1000)): string | undefined {
  let payload: { jwt?: unknown; iat?: unknown };
  try {
    payload = JSON.parse(decryptString(value, 'cookie'));
  } catch {
    return undefined; // tampered / other purpose / pre-R-02 cookie → login form
  }
  const { jwt, iat } = payload ?? {};
  if (typeof jwt !== 'string' || typeof iat !== 'number') return undefined;
  if (iat > now + 60 || now - iat > ME_COOKIE_MAX_AGE_S) return undefined;
  return jwt;
}

export function meCookieHeader(value: string, secure: boolean): string {
  return setCookie('mcp_me', value, ME_COOKIE_MAX_AGE_S, secure, 'Lax');
}

/** Logout only drops the cookie in THIS browser; a copied value stays valid
 *  until its 30-minute iat limit (stateless by design, see docs). */
export function clearMeCookieHeader(secure: boolean): string {
  return setCookie('mcp_me', '', 0, secure, 'Lax');
}

/**
 * The 2FA continuation between the password and the code step (R-26): never
 * in a URL or the page, bound to the authorization request (client + PKCE
 * challenge) and valid for 5 minutes. Wiki.js' own token lives a day. It also
 * names the account, so wrong codes count against it (rate-limit.ts).
 */
export function tfaCookieHeader(
  continuationToken: string,
  bound: { clientId: string; codeChallenge: string },
  username: string,
  secure: boolean,
  now: number = Date.now(),
): string {
  const payload = { t: continuationToken, u: username, cid: bound.clientId, ch: bound.codeChallenge, exp: now + TFA_MAX_AGE_S * 1000 };
  return setCookie('mcp_tfa', encryptString(JSON.stringify(payload), 'tfa'), TFA_MAX_AGE_S, secure, 'Strict');
}

export function clearTfaCookieHeader(secure: boolean): string {
  return setCookie('mcp_tfa', '', 0, secure, 'Strict');
}

/** The continuation (token + account) if the cookie is ours, unexpired and bound to THIS request. */
export function tfaContinuation(
  cookies: CookieJar,
  bound: { clientId: string; codeChallenge: string },
  secure: boolean,
  now: number = Date.now(),
): { token: string; username: string } | undefined {
  const raw = cookies.get(cookieName('mcp_tfa', secure))?.value;
  if (!raw) return undefined;
  let p: { t?: unknown; u?: unknown; cid?: unknown; ch?: unknown; exp?: unknown };
  try {
    p = JSON.parse(decryptString(raw, 'tfa'));
  } catch {
    return undefined;
  }
  if (typeof p.t !== 'string' || typeof p.u !== 'string' || typeof p.exp !== 'number' || p.exp < now) return undefined;
  if (p.cid !== bound.clientId || p.ch !== bound.codeChallenge) return undefined;
  return { token: p.t, username: p.u };
}

/** Request header through which proxy.ts hands the nonce to the consent or /me page. */
export const CONSENT_NONCE_HEADER = 'x-mcp-consent-nonce';

/**
 * What a form nonce is bound to: one authorization request (client + PKCE
 * challenge), or — for the /me forms (login, logout, revoke) — that purpose.
 * Each scope has its own cookie, so an open /me tab never invalidates a
 * consent page in another tab, and a nonce of one scope never passes the other.
 */
export type NonceScope = { clientId: string; codeChallenge: string } | 'me';

const nonceCookie = (scope: NonceScope): CookieBase => (scope === 'me' ? 'mcp_csrf_me' : 'mcp_csrf');
const nonceBinding = (scope: NonceScope): string =>
  scope === 'me' ? 'me' : JSON.stringify([scope.clientId, scope.codeChallenge]);

/**
 * CSRF nonce of the consent page. Wiki.js keeps a <form method="post"
 * action="/oauth/authorize/decision"> with hidden fields and a button in page
 * content; a reader's click on it is a same-origin, user-activated navigation
 * that sameOrigin() and userNavigation() accept, and the wiki's `jwt` cookie
 * identifies the reader. So every render of /oauth/authorize gets a fresh
 * random nonce: in an HttpOnly SameSite=Strict cookie bound to the client and
 * the PKCE challenge, and as a hidden form field. A wiki page can read neither.
 * The /me forms (login, logout, revoke) get the same protection with scope 'me'.
 * Minted in proxy.ts because a server component cannot set cookies.
 * Scope: script-less HTML. A script running on this origin can fetch the page
 * and read the nonce; against that only Wiki.js' HTML sanitizer helps.
 */
export function issueConsentNonce(
  scope: NonceScope,
  secure: boolean,
  now: number = Date.now(),
): { nonce: string; cookie: string } {
  const nonce = randomBytes(32).toString('base64url');
  const payload = { n: nonce, b: nonceBinding(scope), exp: now + CONSENT_NONCE_MAX_AGE_S * 1000 };
  const cookie = setCookie(nonceCookie(scope), encryptString(JSON.stringify(payload), 'csrf'), CONSENT_NONCE_MAX_AGE_S, secure, 'Strict');
  return { nonce, cookie };
}

/** Whether the posted nonce matches this browser's unexpired nonce cookie for THIS scope. */
export function consentNonceValid(
  cookies: CookieJar,
  nonce: string,
  scope: NonceScope,
  secure: boolean,
  now: number = Date.now(),
): boolean {
  const raw = cookies.get(cookieName(nonceCookie(scope), secure))?.value;
  if (!raw || !nonce) return false;
  let p: { n?: unknown; b?: unknown; exp?: unknown };
  try {
    p = JSON.parse(decryptString(raw, 'csrf'));
  } catch {
    return false;
  }
  if (typeof p.n !== 'string' || typeof p.exp !== 'number' || p.exp < now) return false;
  if (p.b !== nonceBinding(scope)) return false;
  return safeEqual(p.n, nonce);
}

/** Whether the request reached us over TLS (directly or via the reverse proxy). */
export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === 'https:' || isSecureHeaders(req.headers);
}

/** Same, for server components that only have headers(). */
export function isSecureHeaders(headers: Headers): boolean {
  return (headers.get('x-forwarded-proto') ?? '').split(',')[0].trim() === 'https';
}

/**
 * CSRF guard for browser POSTs: the Origin header (set by every modern browser
 * on POST) must match the deployment origin. Requests without Origin are
 * rejected — MCP/API clients never call these form endpoints. It does NOT stop
 * same-origin forms in wiki pages (see issueConsentNonce).
 *
 * next.config.js sends `Referrer-Policy: same-origin`, so our own pages post a
 * real Origin. Under `no-referrer` (set by a proxy in front, or inherited)
 * browsers send `Origin: null` even same-origin; then the unforgeable
 * `Sec-Fetch-Site: same-origin` stands in; without Fetch Metadata it fails closed.
 */
export function sameOrigin(req: Request, issuer: string): boolean {
  const origin = req.headers.get('origin');
  if (origin === 'null') return req.headers.get('sec-fetch-site') === 'same-origin';
  return origin !== null && origin === issuer;
}

/**
 * Fetch Metadata guard for the consent decision (R-17): Wiki.js page scripts
 * run on the SAME origin, so Origin alone cannot tell a click from a script.
 * A browser that sends Fetch Metadata must show a user-activated top-level
 * navigation; fetch()/XHR (mode cors/same-origin) and form.submit() outside a
 * user gesture (no Sec-Fetch-User) are refused. Scripts cannot forge these
 * headers. But form.submit() inside a click handler, and a plain <form> in a
 * wiki page that the reader clicks, DO carry `Sec-Fetch-User: ?1`: that case
 * is the consent nonce's job (issueConsentNonce). Browsers without Fetch
 * Metadata (pre-2023 Safari) send no Sec-Fetch-Site and keep the Origin check.
 */
export function userNavigation(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site === null) return true;
  return (
    site === 'same-origin' &&
    req.headers.get('sec-fetch-mode') === 'navigate' &&
    req.headers.get('sec-fetch-user') === '?1'
  );
}

/**
 * Permission probe: is this wiki user a user-manager/admin? Uses Wiki.js' own
 * enforcement (users.list requires write:users / manage:users / manage:system)
 * instead of guessing from group names. Drives the admin section on /me.
 */
export async function isWikiAdmin(jwt: string): Promise<boolean> {
  const client = new WikiClient(wikiBaseUrl(), jwt);
  try {
    await client.request('query { users { list { id } } }');
    return true;
  } catch {
    return false;
  }
}
