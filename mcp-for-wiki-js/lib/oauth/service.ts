/**
 * OAuth 2.1 flows for MCP clients, with the Wiki.js login as the ONLY identity.
 *
 * The pieces (all storage-backed, all offline-testable):
 *   - Dynamic Client Registration (RFC 7591) — public clients, PKCE only.
 *   - Authorization code flow: the authorize page performs the Wiki.js login
 *     (or accepts the browser's existing wiki `jwt` cookie) and calls
 *     issueAuthorizationCode(); the token endpoint exchanges the code.
 *   - Refresh grant with rotation (old refresh token becomes invalid).
 *   - Access-token verification for the /mcp endpoint.
 *
 * Session lifetime piggybacks on Wiki.js' own JWT renewal: every tool call may
 * return a `new-jwt` header which we persist. A session that has been idle
 * longer than the wiki's renewal window (14d default) can no longer renew —
 * refresh/verify then fail and the client simply re-runs the (one-click) flow.
 */

import {
  decryptString,
  encryptString,
  newClientId,
  newToken,
  sha256hex,
  verifyPkce,
} from './crypto';
import * as store from './store';

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 h — refresh happens silently
const CODE_TTL_MS = 5 * 60 * 1000;
/** Wiki.js default auth.tokenRenewal is 14d; after that idle time the stored JWT is dead. */
const SESSION_IDLE_MAX_MS = 14 * 24 * 60 * 60 * 1000;

export class OAuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'unsupported_grant_type'
      | 'invalid_redirect_uri',
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ registration ---

const MAX_REDIRECT_URIS = 20;

/** Loopback redirects are allowed on http; everything else must be https. */
function validRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopbackHost(u.hostname);
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export interface RegistrationResult {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
  grant_types: string[];
  response_types: string[];
}

export function registerClient(body: unknown): RegistrationResult {
  const meta = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
  const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(validRedirectUri)) {
    throw new OAuthError(
      'invalid_redirect_uri',
      'redirect_uris must be 1-20 absolute https URLs (or http on localhost/127.0.0.1) without fragments.',
    );
  }
  const name = typeof meta.client_name === 'string' && meta.client_name.trim() ? meta.client_name.trim().slice(0, 100) : 'MCP client';
  const client: store.ClientRow = {
    id: newClientId(),
    name,
    redirectUris: uris,
    createdAt: Date.now(),
  };
  store.insertClient(client);
  return {
    client_id: client.id,
    client_name: client.name,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

// ------------------------------------------------------------- authorize ---

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
}

/**
 * Match a presented redirect_uri against a registered one. Exact match, except
 * that loopback hosts compare port-agnostically (RFC 8252 §7.3 — MCP clients
 * pick a random localhost port per session).
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  let r: URL, p: URL;
  try {
    r = new URL(registered);
    p = new URL(presented);
  } catch {
    return false;
  }
  if (!isLoopbackHost(r.hostname) || !isLoopbackHost(p.hostname)) return false;
  // Claude registers localhost while some sessions call back on 127.0.0.1 — treat
  // all loopback hosts as equivalent, ports free, everything else exact.
  return r.protocol === p.protocol && r.pathname === p.pathname && r.search === p.search;
}

/** Validate authorize query params against the registered client. Throws OAuthError. */
export function validateAuthorizeRequest(params: AuthorizeParams): store.ClientRow {
  const client = store.getClient(params.clientId);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client_id — register first (RFC 7591).');
  if (!client.redirectUris.some((r) => redirectUriMatches(r, params.redirectUri))) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uri does not match any registered URI.');
  }
  if (params.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9\-_]{43}$/.test(params.codeChallenge)) {
    throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  }
  return client;
}

export interface IssuedCode {
  code: string;
  redirect: string;
}

/** Called by the authorize page AFTER a successful Wiki.js login/consent. */
export function issueAuthorizationCode(
  params: AuthorizeParams,
  identity: { name: string; email: string },
  wikiJwt: string,
): IssuedCode {
  validateAuthorizeRequest(params);
  const code = newToken('mcp_ac_');
  store.insertCode({
    codeHash: sha256hex(code),
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    challenge: params.codeChallenge,
    encJwt: encryptString(wikiJwt),
    userLabel: identity.name,
    userEmail: identity.email,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  const url = new URL(params.redirectUri);
  url.searchParams.set('code', code);
  if (params.state) url.searchParams.set('state', params.state);
  return { code, redirect: url.toString() };
}

// ----------------------------------------------------------------- token ---

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: 'wiki';
}

function issueSessionTokens(): { access: string; refresh: string; accessExpiresAt: number } {
  return {
    access: newToken('mcp_at_'),
    refresh: newToken('mcp_rt_'),
    accessExpiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
  };
}

export function exchangeAuthorizationCode(p: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  clientName?: string;
}): TokenResponse {
  const row = store.consumeCode(sha256hex(p.code)); // single-use: consumed even on later failures
  if (!row) throw new OAuthError('invalid_grant', 'Authorization code is unknown, used or expired.');
  if (row.clientId !== p.clientId) throw new OAuthError('invalid_grant', 'client_id mismatch.');
  if (!redirectUriMatches(row.redirectUri, p.redirectUri)) {
    throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
  }
  if (!verifyPkce(p.codeVerifier, row.challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed.');

  const client = store.getClient(p.clientId);
  const id = crypto.randomUUID();
  const t = issueSessionTokens();
  store.insertSession({
    id,
    accessHash: sha256hex(t.access),
    refreshHash: sha256hex(t.refresh),
    clientId: p.clientId,
    clientName: client?.name ?? 'MCP client',
    userLabel: row.userLabel,
    userEmail: row.userEmail,
    encJwt: row.encJwt,
    accessExpiresAt: t.accessExpiresAt,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    revokedAt: null,
  });
  return {
    access_token: t.access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: t.refresh,
    scope: 'wiki',
  };
}

export function refreshAccessToken(p: { refreshToken: string; clientId: string }): TokenResponse {
  const hash = sha256hex(p.refreshToken);
  const session = store.getSessionByRefreshHash(hash);
  if (!session) {
    // OAuth 2.1 reuse detection: a refresh token that was ALREADY rotated is
    // being replayed — assume theft and kill the whole session family.
    const reused = store.getSessionByPrevRefreshHash(hash);
    if (reused && !reused.revokedAt) {
      store.revokeSession(reused.id);
      console.error(`OAuth: refresh-token reuse detected — session ${reused.id} revoked.`);
    }
    throw new OAuthError('invalid_grant', 'Refresh token is invalid or revoked.');
  }
  if (session.revokedAt) throw new OAuthError('invalid_grant', 'Refresh token is invalid or revoked.');
  if (session.clientId !== p.clientId) throw new OAuthError('invalid_grant', 'client_id mismatch.');
  if (Date.now() - session.lastUsedAt > SESSION_IDLE_MAX_MS) {
    // The stored wiki JWT is past Wiki.js' renewal window — force a fresh login.
    store.revokeSession(session.id);
    throw new OAuthError('invalid_grant', 'Session expired after inactivity — authorize again.');
  }
  const t = issueSessionTokens();
  store.rotateSessionTokens(session.id, sha256hex(t.access), sha256hex(t.refresh), t.accessExpiresAt);
  return {
    access_token: t.access,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: t.refresh,
    scope: 'wiki',
  };
}

// ---------------------------------------------------------------- verify ---

export interface VerifiedSession {
  sessionId: string;
  wikiJwt: string;
  label: string;
  email: string;
  clientId: string;
  /** Unix seconds — handed to the MCP auth wrapper which enforces expiry. */
  expiresAtSec: number;
}

const TOUCH_INTERVAL_MS = 60 * 1000;

/** Resolve a presented access token to a live session (undefined = not ours / dead). */
export function verifyAccessToken(bearer: string): VerifiedSession | undefined {
  if (!bearer.startsWith('mcp_at_')) return undefined;
  const session = store.getSessionByAccessHash(sha256hex(bearer));
  if (!session || session.revokedAt) return undefined;
  if (session.accessExpiresAt < Date.now()) return undefined;
  if (Date.now() - session.lastUsedAt > TOUCH_INTERVAL_MS) store.touchSession(session.id);
  return {
    sessionId: session.id,
    wikiJwt: decryptString(session.encJwt),
    label: session.userLabel,
    email: session.userEmail,
    clientId: session.clientId,
    expiresAtSec: Math.floor(session.accessExpiresAt / 1000),
  };
}

/** Persist a renewed Wiki.js JWT captured from a `new-jwt` response header. */
export function persistRenewedJwt(sessionId: string, jwt: string): void {
  store.updateSessionJwt(sessionId, encryptString(jwt));
}
