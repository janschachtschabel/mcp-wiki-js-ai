/**
 * Offline tests for the OAuth 2.1 layer (lib/oauth/*): crypto roundtrip, PKCE,
 * DCR validation, the full code→token→refresh→revoke flow, single-use codes,
 * refresh rotation and loopback redirect matching. No network, no disk —
 * the store runs on an in-memory sqlite DB.  Run: npm run test:oauth
 */
process.env.MCP_SESSION_SECRET = 'test-secret-for-oauth-suite-0123456789';

import { createHash, randomBytes } from 'node:crypto';

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

  store.openTestStore();

  // ---- crypto -------------------------------------------------------------
  const secretText = 'wiki-jwt-payload-äöü-🔑';
  check('encrypt/decrypt roundtrip', crypto.decryptString(crypto.encryptString(secretText)) === secretText);
  check('ciphertexts are salted (two encryptions differ)', crypto.encryptString('x') !== crypto.encryptString('x'));
  let tampered = false;
  try {
    const c = crypto.encryptString('x');
    crypto.decryptString(c.slice(0, -4) + 'AAAA');
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

  const identity = { name: 'Alice', email: 'alice@example.org' };
  const issued = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_1');
  check('code redirect goes to the client', issued.redirect.startsWith('https://claude.ai/api/mcp/auth_callback?'));
  check('code redirect carries state', new URL(issued.redirect).searchParams.get('state') === 'xyz');

  const tokens = service.exchangeAuthorizationCode({
    code: issued.code,
    clientId: reg.client_id,
    redirectUri: params.redirectUri,
    codeVerifier: verifier,
  });
  check('token exchange returns bearer', tokens.token_type === 'Bearer' && tokens.access_token.startsWith('mcp_at_'));
  check('token exchange returns refresh token', tokens.refresh_token.startsWith('mcp_rt_'));

  expectOAuthError(
    'auth code is single-use',
    () =>
      service.exchangeAuthorizationCode({
        code: issued.code,
        clientId: reg.client_id,
        redirectUri: params.redirectUri,
        codeVerifier: verifier,
      }),
    'invalid_grant',
  );

  const issued2 = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_2');
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
  // Replaying the ALREADY-ROTATED refresh token is the OAuth 2.1 theft signal:
  // it must fail AND take the whole session down with it.
  expectOAuthError(
    'replayed old refresh token is rejected',
    () => service.refreshAccessToken({ refreshToken: tokens.refresh_token, clientId: reg.client_id }),
    'invalid_grant',
  );
  check('reuse detection revoked the session', service.verifyAccessToken(refreshed.access_token) === undefined);
  expectOAuthError(
    'revoked session cannot refresh',
    () => service.refreshAccessToken({ refreshToken: refreshed.refresh_token, clientId: reg.client_id }),
    'invalid_grant',
  );

  // ---- /me listing --------------------------------------------------------
  const issued3 = service.issueAuthorizationCode(params, identity, 'WIKI_JWT_3');
  service.exchangeAuthorizationCode({
    code: issued3.code,
    clientId: reg.client_id,
    redirectUri: params.redirectUri,
    codeVerifier: verifier,
  });
  const mine = store.listSessionsByEmail('alice@example.org');
  check('listSessionsByEmail sees all sessions', mine.length === 2);
  check('listSessionsByEmail scopes by email', store.listSessionsByEmail('bob@example.org').length === 0);

  // ---- admin listing + session hygiene --------------------------------------
  const activeNow = store.listActiveSessions();
  check('listActiveSessions returns only unrevoked sessions', activeNow.every((s) => !s.revokedAt));

  const old = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago — beyond every retention window
  store.insertSession({
    id: 'stale-session', accessHash: 'x1', refreshHash: 'x2', clientId: 'c', clientName: 'Old client',
    userLabel: 'Old', userEmail: 'old@example.org', encJwt: 'enc', accessExpiresAt: old,
    createdAt: old, lastUsedAt: old, revokedAt: null,
  });
  check('stale session exists before cleanup', store.getSessionById('stale-session') !== undefined);
  store.cleanupSessions();
  check('cleanup purges idle-expired sessions', store.getSessionById('stale-session') === undefined);
  check('cleanup keeps live sessions', store.listSessionsByEmail('alice@example.org').length === 2);

  store.insertAudit({ ts: Date.now(), sessionId: null, profile: 'Alice', tool: 'wiki_page_update', category: 'write', outcome: 'ok', ms: 12 });
  const audit = store.listAudit(10);
  check('listAudit returns entries, newest first', audit.length >= 1 && audit[0].tool === 'wiki_page_update');

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
