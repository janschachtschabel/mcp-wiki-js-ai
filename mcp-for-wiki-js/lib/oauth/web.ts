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

import { decryptString, encryptString } from './crypto';
import { fetchIdentity, type WikiIdentity } from './wiki-login';
import { WikiClient } from '../wikijs/client';

export const ME_COOKIE = 'mcp_me';
/** Matches Wiki.js' default tokenExpiration (30m) — the cookie is only a convenience. */
export const ME_COOKIE_MAX_AGE_S = 30 * 60;

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

/**
 * Try to identify the browser user from cookies (no credentials involved).
 * Every JWT is validated against Wiki.js before it is trusted.
 */
export async function identityFromCookies(cookies: {
  get(name: string): { value: string } | undefined;
}): Promise<BrowserIdentity | undefined> {
  const wikiJwt = cookies.get('jwt')?.value;
  if (wikiJwt) {
    const identity = await fetchIdentity(wikiBaseUrl(), wikiJwt);
    // Wiki.js sets the guest cookie too — a valid profile with an email is a real user.
    if (identity && identity.email && identity.email !== 'guest@example.com') {
      return { identity, jwt: wikiJwt, source: 'wiki-cookie' };
    }
  }
  const me = cookies.get(ME_COOKIE)?.value;
  if (me) {
    try {
      const jwt = decryptString(me);
      const identity = await fetchIdentity(wikiBaseUrl(), jwt);
      if (identity) return { identity, jwt, source: 'me-cookie' };
    } catch {
      /* tampered/stale cookie — fall through to the login form */
    }
  }
  return undefined;
}

/** Serialized Set-Cookie value for our own session cookie (encrypted wiki JWT). */
export function meCookieValue(jwt: string): string {
  return encryptString(jwt);
}

export function meCookieHeader(value: string, secure: boolean): string {
  return (
    `${ME_COOKIE}=${value}; Path=/; Max-Age=${ME_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax` +
    (secure ? '; Secure' : '')
  );
}

export function clearMeCookieHeader(): string {
  return `${ME_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/** Whether the request reached us over TLS (directly or via the reverse proxy). */
export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
}

/**
 * CSRF guard for browser POSTs: the Origin header (set by every modern browser
 * on POST) must match the deployment origin. Requests without Origin are
 * rejected — MCP/API clients never call these form endpoints.
 */
export function sameOrigin(req: Request, issuer: string): boolean {
  const origin = req.headers.get('origin');
  return origin !== null && origin === issuer;
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
