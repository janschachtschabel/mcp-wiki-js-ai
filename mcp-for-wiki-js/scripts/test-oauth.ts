/**
 * Offline tests for the OAuth 2.1 layer (lib/oauth/*): crypto roundtrip, PKCE,
 * DCR validation, the full code→token→refresh→revoke flow, single-use codes,
 * refresh rotation and loopback redirect matching. No network, no disk —
 * the store runs on an in-memory sqlite DB.  Run: npm run test:oauth
 */
process.env.MCP_SESSION_SECRET = 'test-secret-for-oauth-suite-0123456789';

import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

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

function expectOAuthError(name: string, fn: () => unknown, code: string): void {
  try {
    fn();
    check(`${name} (expected ${code})`, false);
  } catch (e) {
    const actual = (e as { code?: string }).code;
    check(`${name} → ${code}`, actual === code);
  }
}

async function main(): Promise<void> {
  const crypto = await import('../lib/oauth/crypto');
  const store = await import('../lib/oauth/store');
  const service = await import('../lib/oauth/service');
  const web = await import('../lib/oauth/web');

  store.openTestStore();
  const ISSUER = 'https://mcp.example.org';

  // ---- crypto -------------------------------------------------------------
  const secretText = 'wiki-jwt-payload-äöü-🔑';
  check('encrypt/decrypt roundtrip', crypto.decryptString(crypto.encryptString(secretText, 'db-jwt'), 'db-jwt') === secretText);
  check('ciphertexts are salted (two encryptions differ)', crypto.encryptString('x', 'db-jwt') !== crypto.encryptString('x', 'db-jwt'));
  let tampered = false;
  try {
    const c = crypto.encryptString('x', 'db-jwt');
    crypto.decryptString(c.slice(0, -4) + 'AAAA', 'db-jwt');
  } catch {
    tampered = true;
  }
  check('tampered ciphertext throws', tampered);
  check('token prefix', crypto.newToken('mcp_at_').startsWith('mcp_at_'));

  // ---- PKCE ---------------------------------------------------------------
  const verifier = randomBytes(48).toString('base64url'); // 64 chars, valid charset
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  check('PKCE S256 verifies', crypto.verifyPkce(verifier, challenge));
  check('PKCE rejects wrong verifier', !crypto.verifyPkce(randomBytes(48).toString('base64url'), challenge));
  check('PKCE rejects short verifier', !crypto.verifyPkce('short', challenge));

  // ---- registration -------------------------------------------------------
  const reg = service.registerClient({
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:33418/callback'],
  });
  check('DCR issues a client_id', reg.client_id.startsWith('mcp_client_'));
  check('DCR is public-client only', reg.token_endpoint_auth_method === 'none');
  expectOAuthError('DCR rejects empty redirect_uris', () => service.registerClient({ redirect_uris: [] }), 'invalid_redirect_uri');
  expectOAuthError(
    'DCR rejects http on non-loopback',
    () => service.registerClient({ redirect_uris: ['http://evil.example/cb'] }),
    'invalid_redirect_uri',
  );

  // ---- R-16: optional allowlist of redirect hosts --------------------------
  process.env.MCP_ALLOWED_REDIRECT_HOSTS = 'claude.ai, ChatGPT.com';
  expectOAuthError(
    'R-16: allowlist set → DCR rejects a redirect host outside it',
    () => service.registerClient({ redirect_uris: ['https://evil.example/cb'] }),
    'invalid_redirect_uri',
  );
  check('R-16: allowlisted host registers (case-insensitive)', service.registerClient({ redirect_uris: ['https://chatgpt.com/cb'] }).client_id.startsWith('mcp_client_'));
  check('R-16: loopback stays allowed (local clients)', service.registerClient({ redirect_uris: ['http://127.0.0.1:5000/cb'] }).client_id.startsWith('mcp_client_'));
  delete process.env.MCP_ALLOWED_REDIRECT_HOSTS;
  const evil = service.registerClient({ client_name: 'Claude', redirect_uris: ['https://evil.example/cb'] });
  process.env.MCP_ALLOWED_REDIRECT_HOSTS = 'claude.ai';
  expectOAuthError(
    'R-16: clients registered before the allowlist are refused at authorize',
    () => service.validateAuthorizeRequest({ clientId: evil.client_id, redirectUri: 'https://evil.example/cb', codeChallenge: 'A'.repeat(43), codeChallengeMethod: 'S256' }),
    'invalid_redirect_uri',
  );
  delete process.env.MCP_ALLOWED_REDIRECT_HOSTS;
  check('R-16: without the env every https host stays allowed (default off)', service.registerClient({ redirect_uris: ['https://evil.example/cb'] }).client_id.startsWith('mcp_client_'));

  // ---- redirect matching --------------------------------------------------
  check(
    'loopback matching is port-agnostic',
    service.redirectUriMatches('http://localhost:33418/callback', 'http://127.0.0.1:5091/callback'),
  );
  check(
    'non-loopback requires exact match',
    !service.redirectUriMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/other'),
  );

  // ---- authorize → code → token -------------------------------------------
  const params = {
    clientId: reg.client_id,
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state: 'xyz',
  };
  expectOAuthError(
    'authorize rejects unknown client',
    () => service.validateAuthorizeRequest({ ...params, clientId: 'mcp_client_nope' }),
    'invalid_client',
  );
  expectOAuthError(
    'authorize rejects unregistered redirect_uri',
    () => service.validateAuthorizeRequest({ ...params, redirectUri: 'https://evil.example/cb' }),
    'invalid_redirect_uri',
  );
  expectOAuthError(
    'authorize rejects plain PKCE',
    () => service.validateAuthorizeRequest({ ...params, codeChallengeMethod: 'plain' }),
    'invalid_request',
  );

  const identity = { id: 7, name: 'Alice', email: 'alice@example.org' };
  const issued = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_1', ISSUER);
  check('code redirect goes to the client', issued.redirect.startsWith('https://claude.ai/api/mcp/auth_callback?'));
  check('code redirect carries state', new URL(issued.redirect).searchParams.get('state') === 'xyz');
  check('R-48: code redirect carries iss (RFC 9207)', new URL(issued.redirect).searchParams.get('iss') === ISSUER);

  // R-48: RFC 8707 resource indicator — absent or this server's /mcp only.
  check('R-48: no resource parameter is accepted', (() => { try { service.validateResource(undefined, ISSUER); return true; } catch { return false; } })());
  check('R-48: own resource URL is accepted', (() => { try { service.validateResource(`${ISSUER}/mcp`, ISSUER); return true; } catch { return false; } })());
  check('R-48: own resource URL with trailing slash is accepted', (() => { try { service.validateResource(`${ISSUER}/mcp/`, ISSUER); return true; } catch { return false; } })());
  expectOAuthError('R-48: foreign resource → invalid_target', () => service.validateResource('https://other.example/mcp', ISSUER), 'invalid_target');
  expectOAuthError('R-48: unparsable resource → invalid_target', () => service.validateResource('not a url', ISSUER), 'invalid_target');

  const tokens = service.exchangeAuthorizationCode({
    code: issued.code,
    clientId: reg.client_id,
    redirectUri: params.redirectUri,
    codeVerifier: verifier,
  });
  check('token exchange returns bearer', tokens.token_type === 'Bearer' && tokens.access_token.startsWith('mcp_at_'));
  check('token exchange returns refresh token', tokens.refresh_token.startsWith('mcp_rt_'));

  // Own code: since R-25 a second redemption also revokes the first one's
  // session, and the session from `issued` is used further down.
  const issuedOnce = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_ONCE', ISSUER);
  const redeemOnce = () =>
    service.exchangeAuthorizationCode({
      code: issuedOnce.code,
      clientId: reg.client_id,
      redirectUri: params.redirectUri,
      codeVerifier: verifier,
    });
  redeemOnce();
  expectOAuthError('auth code is single-use', redeemOnce, 'invalid_grant');

  const issued2 = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_2', ISSUER);
  expectOAuthError(
    'token exchange rejects wrong PKCE verifier',
    () =>
      service.exchangeAuthorizationCode({
        code: issued2.code,
        clientId: reg.client_id,
        redirectUri: params.redirectUri,
        codeVerifier: randomBytes(48).toString('base64url'),
      }),
    'invalid_grant',
  );

  // ---- verify -------------------------------------------------------------
  const session = service.verifyAccessToken(tokens.access_token);
  check('access token verifies to the session', session?.label === 'Alice' && session?.email === 'alice@example.org');
  check('verified session decrypts the wiki JWT', session?.wikiJwt === 'WIKI_JWT_1');
  check('foreign bearer is ignored (undefined)', service.verifyAccessToken('some-wikijs-api-key') === undefined);

  // ---- renewal persistence ------------------------------------------------
  service.persistRenewedJwt(session!.sessionId, 'WIKI_JWT_RENEWED');
  check('renewed JWT is persisted', service.verifyAccessToken(tokens.access_token)?.wikiJwt === 'WIKI_JWT_RENEWED');

  // ---- audit R-02: one key per purpose ------------------------------------
  // A DB copy must not log anyone in: the stored ciphertext is no valid mcp_me cookie.
  const dbCipher = store.getSessionById(session!.sessionId)!.encJwt;
  check('R-02: DB ciphertext (oauth_sessions.enc_jwt) is NOT a valid mcp_me cookie', web.meCookieJwt(dbCipher) === undefined);
  const cookie = web.meCookieValue('WIKI_JWT_COOKIE');
  check('R-02: mcp_me cookie roundtrip', web.meCookieJwt(cookie) === 'WIKI_JWT_COOKIE');
  check('R-02: a cookie does not decrypt as a DB value', (() => {
    try { crypto.decryptString(cookie, 'db-jwt'); return false; } catch { return true; }
  })());
  // Well-formed, fresh cookie payloads under another purpose's key — only key separation rejects them.
  const nowS = Math.floor(Date.now() / 1000);
  const forged = JSON.stringify({ jwt: 'X', iat: nowS });
  check('R-02: a fresh cookie payload under the DB key is not a cookie', web.meCookieJwt(crypto.encryptString(forged, 'db-jwt')) === undefined);
  check('R-02: a fresh cookie payload under the 2FA key is not a cookie', web.meCookieJwt(crypto.encryptString(forged, 'tfa')) === undefined);
  check('R-02: cookie expires server-side after max-age',
    web.meCookieJwt(web.meCookieValue('J', nowS - web.ME_COOKIE_MAX_AGE_S - 1)) === undefined);
  check('R-02: cookie valid just inside max-age',
    web.meCookieJwt(web.meCookieValue('J', nowS - web.ME_COOKIE_MAX_AGE_S + 5)) === 'J');
  // Existing sessions survive the upgrade: the DB purpose keeps the pre-R-02 key derivation.
  const legacyKey = Buffer.from(hkdfSync('sha256', process.env.MCP_SESSION_SECRET!, 'wikijs-mcp', 'wikijs-mcp/session-encryption/v1', 32));
  const iv = randomBytes(12);
  const c0 = createCipheriv('aes-256-gcm', legacyKey, iv);
  const ct0 = Buffer.concat([c0.update('PRE_UPGRADE_JWT', 'utf8'), c0.final()]);
  const legacyCipher = Buffer.concat([iv, c0.getAuthTag(), ct0]).toString('base64url');
  check('R-02: pre-upgrade DB ciphertext still decrypts (sessions stay valid)', crypto.decryptString(legacyCipher, 'db-jwt') === 'PRE_UPGRADE_JWT');

  // ---- refresh rotation ---------------------------------------------------
  const refreshed = service.refreshAccessToken({ refreshToken: tokens.refresh_token, clientId: reg.client_id });
  check('refresh issues a new access token', refreshed.access_token !== tokens.access_token);
  check('old access token is dead after rotation', service.verifyAccessToken(tokens.access_token) === undefined);
  expectOAuthError(
    'refresh rejects wrong client',
    () => service.refreshAccessToken({ refreshToken: refreshed.refresh_token, clientId: 'mcp_client_other' }),
    'invalid_grant',
  );
  const live = service.verifyAccessToken(refreshed.access_token);
  check('rotated access token verifies (session still alive)', live !== undefined);

  // ---- reuse detection + revoke -------------------------------------------
  // R-40: a replay right after the rotation is a lost response or a parallel
  // refresh of the same client, not theft — rejected, but the session lives.
  expectOAuthError(
    'R-40: replay within the grace window is rejected',
    () => service.refreshAccessToken({ refreshToken: tokens.refresh_token, clientId: reg.client_id }),
    'invalid_grant',
  );
  check('R-40: replay within the grace window does NOT revoke the session', service.verifyAccessToken(refreshed.access_token) !== undefined);
  // Replaying the ALREADY-ROTATED refresh token later is the OAuth 2.1 theft
  // signal: it must fail AND take the whole session down with it.
  expectOAuthError(
    'replayed old refresh token is rejected',
    () => service.refreshAccessToken({ refreshToken: tokens.refresh_token, clientId: reg.client_id }, Date.now() + 61_000),
    'invalid_grant',
  );
  check('reuse detection revoked the session', service.verifyAccessToken(refreshed.access_token) === undefined);
  expectOAuthError(
    'revoked session cannot refresh',
    () => service.refreshAccessToken({ refreshToken: refreshed.refresh_token, clientId: reg.client_id }),
    'invalid_grant',
  );

  // ---- /me listing --------------------------------------------------------
  const issued3 = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_3', ISSUER);
  service.exchangeAuthorizationCode({
    code: issued3.code,
    clientId: reg.client_id,
    redirectUri: params.redirectUri,
    codeVerifier: verifier,
  });
  const mine = store.listSessionsForUser(7, 'alice@example.org');
  check('listSessionsForUser sees all sessions (main, single-use, /me fixture)', mine.length === 3);
  check('R-41: sessions carry the wiki user id from the login', mine.every((s) => s.userId === 7));
  check('listSessionsForUser scopes by user', store.listSessionsForUser(8, 'bob@example.org').length === 0);
  check('R-41: same email, other wiki account (e.g. other auth provider) → not listed', store.listSessionsForUser(8, 'alice@example.org').length === 0);

  // ---- admin listing + session hygiene --------------------------------------
  const activeNow = store.listActiveSessions();
  check('listActiveSessions returns only unrevoked sessions', activeNow.every((s) => !s.revokedAt));

  const old = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago — beyond every retention window
  store.insertSession({
    id: 'stale-session', accessHash: 'x1', refreshHash: 'x2', clientId: 'c', clientName: 'Old client',
    userLabel: 'Old', userEmail: 'old@example.org', userId: null, encJwt: 'enc', accessExpiresAt: old,
    createdAt: old, lastUsedAt: old, revokedAt: null,
  });
  // insertSession prunes AFTER its insert (see store.ts) — an already-stale row goes at once
  // (a failed insert would have thrown above).
  check('session insert purges idle-expired sessions', store.getSessionById('stale-session') === undefined);
  store.cleanupSessions();
  check('cleanup keeps live sessions', store.listSessionsForUser(7, 'alice@example.org').length === 3);

  // R-10: open DCR must not grow forever — clients without any session/code are purged after 24h.
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  store.insertClient({ id: 'mcp_client_unused_old', name: 'flood', redirectUris: ['https://x.example/cb'], createdAt: twoDaysAgo });
  store.insertClient({ id: 'mcp_client_unused_new', name: 'fresh', redirectUris: ['https://x.example/cb'], createdAt: Date.now() });
  store.insertClient({ id: 'mcp_client_used_old', name: 'used', redirectUris: ['https://x.example/cb'], createdAt: twoDaysAgo });
  store.insertSession({
    id: 'live-on-old-client', accessHash: 'y1', refreshHash: 'y2', clientId: 'mcp_client_used_old', clientName: 'used',
    userLabel: 'U', userEmail: 'u@example.org', userId: 9, encJwt: 'enc', accessExpiresAt: Date.now() + 3600_000,
    createdAt: Date.now(), lastUsedAt: Date.now(), revokedAt: null,
  });
  store.cleanupSessions();
  check('cleanup purges old clients without sessions', store.getClient('mcp_client_unused_old') === undefined);
  check('cleanup keeps freshly registered clients (authorization may be in progress)', store.getClient('mcp_client_unused_new') !== undefined);
  check('cleanup keeps old clients that still have a session', store.getClient('mcp_client_used_old') !== undefined);
  check('cleanup keeps the active test client', store.getClient(reg.client_id) !== undefined);
  // Token exchange consumes the code BEFORE the session row exists — an old client must survive that.
  store.insertClient({ id: 'mcp_client_reauth', name: 'returning', redirectUris: [params.redirectUri], createdAt: twoDaysAgo });
  const reauth = service.issueAuthorizationCode({ ...params, clientId: 'mcp_client_reauth' }, identity, 'WIKI_JWT_RA', ISSUER);
  service.exchangeAuthorizationCode({ code: reauth.code, clientId: 'mcp_client_reauth', redirectUri: params.redirectUri, codeVerifier: verifier });
  check('old client survives its own code→token exchange', store.getClient('mcp_client_reauth') !== undefined);

  store.insertAudit({ ts: Date.now(), sessionId: null, profile: 'Alice', tool: 'wiki_page_update', category: 'write', outcome: 'ok', ms: 12 });
  const audit = store.listAudit(10);
  check('listAudit returns entries, newest first', audit.length >= 1 && audit[0].tool === 'wiki_page_update');

  // Audit retention: entries older than the window are purged, recent ones kept.
  const ancient = Date.now() - 200 * 24 * 60 * 60 * 1000; // 200 days — beyond the 180d audit window
  store.insertAudit({ ts: ancient, sessionId: null, profile: 'Old', tool: 'wiki_page_delete', category: 'delete', outcome: 'ok', ms: 5 });
  store.cleanupSessions();
  const afterCleanup = store.listAudit(50);
  check('cleanup purges aged-out audit rows', !afterCleanup.some((a) => a.ts === ancient));
  check('cleanup keeps recent audit rows', afterCleanup.some((a) => a.tool === 'wiki_page_update'));

  // A refresh grant also triggers cleanup (bounds the store without new sessions).
  const issuedR = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_R', ISSUER);
  const tokR = service.exchangeAuthorizationCode({
    code: issuedR.code, clientId: reg.client_id, redirectUri: params.redirectUri, codeVerifier: verifier,
  });
  const ancient2 = Date.now() - 210 * 24 * 60 * 60 * 1000;
  store.insertAudit({ ts: ancient2, sessionId: null, profile: 'Old2', tool: 'x', category: 'delete', outcome: 'ok', ms: 1 });
  service.refreshAccessToken({ refreshToken: tokR.refresh_token, clientId: reg.client_id });
  check('refresh grant triggers audit cleanup', !store.listAudit(50).some((a) => a.ts === ancient2));

  // ---- R-25: authorization-code reuse revokes what the code produced --------
  const issuedReuse = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_REUSE', ISSUER);
  const exchange = () =>
    service.exchangeAuthorizationCode({ code: issuedReuse.code, clientId: reg.client_id, redirectUri: params.redirectUri, codeVerifier: verifier });
  const tokReuse = exchange();
  check('R-25: first redemption works', service.verifyAccessToken(tokReuse.access_token) !== undefined);
  expectOAuthError('R-25: second redemption → invalid_grant', exchange, 'invalid_grant');
  check('R-25: second redemption revoked the tokens issued from the code', service.verifyAccessToken(tokReuse.access_token) === undefined);
  expectOAuthError(
    'R-25: … including the refresh token',
    () => service.refreshAccessToken({ refreshToken: tokReuse.refresh_token, clientId: reg.client_id }),
    'invalid_grant',
  );

  // ---- R-25: absolute session lifetime ---------------------------------------
  const issuedAbs = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_ABS', ISSUER);
  const tokAbs = service.exchangeAuthorizationCode({ code: issuedAbs.code, clientId: reg.client_id, redirectUri: params.redirectUri, codeVerifier: verifier });
  const absSession = service.verifyAccessToken(tokAbs.access_token)!;
  const beyondMax = Date.now() + service.SESSION_ABSOLUTE_MAX_MS + 1000;
  // Keep the session "in use" so only the absolute cap (not idleness) can end it.
  store.touchSession(absSession.sessionId, beyondMax - 1000);
  expectOAuthError(
    'R-25: refresh after the absolute maximum lifetime → invalid_grant',
    () => service.refreshAccessToken({ refreshToken: tokAbs.refresh_token, clientId: reg.client_id }, beyondMax),
    'invalid_grant',
  );
  check('R-25: … and the session is revoked', store.getSessionById(absSession.sessionId)?.revokedAt != null);

  // ---- R-44: "active" means usable, not merely "not revoked" -----------------
  const base = store.getSessionById(absSession.sessionId)!;
  const fresh = { ...base, revokedAt: null, createdAt: Date.now(), lastUsedAt: Date.now() };
  check('R-44: fresh session is active', service.isSessionActive(fresh));
  check('R-44: revoked session is not active', !service.isSessionActive({ ...fresh, revokedAt: Date.now() }));
  check('R-44: idle-expired session is not active', !service.isSessionActive({ ...fresh, lastUsedAt: Date.now() - 15 * 24 * 3600_000 }));
  check('R-44: session past the absolute maximum is not active', !service.isSessionActive({ ...fresh, createdAt: Date.now() - service.SESSION_ABSOLUTE_MAX_MS - 1000 }));

  // ---- R-48: token revocation (RFC 7009) --------------------------------------
  const issuedRev = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_REV', ISSUER);
  const tokRev = service.exchangeAuthorizationCode({ code: issuedRev.code, clientId: reg.client_id, redirectUri: params.redirectUri, codeVerifier: verifier });
  service.revokeToken({ token: tokRev.access_token, clientId: 'mcp_client_other' });
  check('R-48: revocation by a different client is ignored', service.verifyAccessToken(tokRev.access_token) !== undefined);
  service.revokeToken({ token: 'mcp_rt_unknown', clientId: reg.client_id }); // unknown token: no error (RFC 7009 §2.2)
  service.revokeToken({ token: tokRev.refresh_token, clientId: reg.client_id });
  check('R-48: revoking the refresh token ends the session (access token dead too)', service.verifyAccessToken(tokRev.access_token) === undefined);
  const issuedRev2 = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_REV2', ISSUER);
  const tokRev2 = service.exchangeAuthorizationCode({ code: issuedRev2.code, clientId: reg.client_id, redirectUri: params.redirectUri, codeVerifier: verifier });
  service.revokeToken({ token: tokRev2.access_token, clientId: reg.client_id });
  check('R-48: revoking the access token ends the session', service.verifyAccessToken(tokRev2.access_token) === undefined);

  if (failed === 0) {
    console.log(`\n${pass} oauth assertions passed.`);
  } else {
    console.log(`\n${failed} FAILED (of ${pass + failed}).`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
