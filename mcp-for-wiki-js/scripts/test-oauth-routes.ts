/**
 * Offline tests for the machine-facing OAuth endpoints: error reporting
 * (R-39), health with a broken store (R-39), audit write failures (R-39),
 * the shared "OAuth off" answer (R-59), metadata caching and flags (R-24,
 * R-48), token revocation (R-48), the resource indicator at the token endpoint
 * (R-48), the DCR rate limit (R-10/R-11) and the single public-URL helper (R-58).
 * No network; route handlers are called with Request objects.
 * Run: npm run test:oauth-routes
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const SECRET = 'test-secret-for-oauth-routes-0123456789';
process.env.MCP_SESSION_SECRET = SECRET;
process.env.WIKIJS_URL = 'http://wiki.test';
delete process.env.PUBLIC_BASE_URL;
delete process.env.WIKIJS_ALLOW_LEGACY;

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

const ORIGIN = 'http://mcp.test';

function form(path: string, body: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

function json(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Capture console.error lines while fn runs (and for pending microtasks after it). */
async function capturingErrors(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 50)); // fire-and-forget writes settle
  } finally {
    console.error = orig;
  }
  return lines;
}

async function main(): Promise<void> {
  const store = await import('../lib/oauth/store');
  const service = await import('../lib/oauth/service');
  const health = await import('../app/api/health/route');
  const token = await import('../app/oauth/token/route');
  const register = await import('../app/oauth/register/route');
  const revoke = await import('../app/oauth/revoke/route');
  const asMeta = await import('../app/.well-known/oauth-authorization-server/route');
  const mcpJson = await import('../app/.well-known/mcp.json/route');
  const { resolveIssuer } = await import('../lib/oauth/metadata');

  // ---- 1. broken store: server errors are 5xx and logged (R-39) -------------
  const dir = mkdtempSync(join(tmpdir(), 'mcp-routes-test-'));
  const notADir = join(dir, 'file');
  writeFileSync(notADir, 'x');
  process.env.MCP_DATA_DIR = join(notADir, 'sub'); // mkdir under a regular file fails
  try {
    const h = await health.GET();
    check('R-39: health is 503 when the OAuth store cannot open', h.status === 503 && (await h.json()).ok === false);

    let tokenRes: Response | undefined;
    const tokenLog = await capturingErrors(async () => {
      tokenRes = await token.POST(form('/oauth/token', { grant_type: 'authorization_code', code: 'mcp_ac_x', client_id: 'c', redirect_uri: 'https://x/cb', code_verifier: 'v' }));
    });
    const tokenBody = (await tokenRes!.json()) as { error?: string; error_description?: string };
    check('R-39: token endpoint answers a server fault with 500 server_error', tokenRes!.status === 500 && tokenBody.error === 'server_error');
    check('R-39: … without leaking the internal message', !/MCP_DATA_DIR|ENOTDIR|EEXIST|mkdir/i.test(tokenBody.error_description ?? ''));
    check('R-39: … and logs it server-side', tokenLog.some((l) => /token/i.test(l)));

    let regRes: Response | undefined;
    const regLog = await capturingErrors(async () => {
      regRes = await register.POST(json('/oauth/register', { redirect_uris: ['https://client.example/cb'] }, { 'x-forwarded-for': '198.51.100.1' }));
    });
    check('R-39: register endpoint answers a server fault with 500', regRes!.status === 500 && (await regRes!.json()).error === 'server_error');
    check('R-39: … and logs it server-side', regLog.some((l) => /regist/i.test(l)));

    // Audit write failure is reported, not swallowed (lib/register.ts).
    const { registerAll } = await import('../lib/register');
    const handlers = new Map<string, (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>>();
    registerAll({ registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h) } as never);
    const write = handlers.get('wiki_page_create');
    const auditLog = await capturingErrors(async () => {
      check('R-39: (harness) a state-changing tool is registered', write !== undefined);
      await write?.({ path: 'x', title: 'x', content: 'x', confirm: true }, {});
    });
    check('R-39: a failed audit write is logged, not swallowed', auditLog.some((l) => /audit/i.test(l)));
  } finally {
    delete process.env.MCP_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- 2. healthy store -------------------------------------------------------
  store.openTestStore();
  const okHealth = await health.GET();
  check('R-39: health is 200 with a working store', okHealth.status === 200 && (await okHealth.json()).ok === true);

  const badGrant = await token.POST(form('/oauth/token', { grant_type: 'password' }));
  check('client errors stay 400 (unsupported_grant_type)', badGrant.status === 400 && (await badGrant.json()).error === 'unsupported_grant_type');
  const badReg = await register.POST(json('/oauth/register', { redirect_uris: [] }, { 'x-forwarded-for': '198.51.100.2' }));
  check('client errors stay 400 (invalid_redirect_uri)', badReg.status === 400 && (await badReg.json()).error === 'invalid_redirect_uri');

  // ---- 3. resource indicator at the token endpoint (R-48) -------------------
  const reg = service.registerClient({ client_name: 'T', redirect_uris: ['https://client.example/cb'] });
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const params = { clientId: reg.client_id, redirectUri: 'https://client.example/cb', codeChallenge: challenge, codeChallengeMethod: 'S256' };
  const identity = { id: 1, name: 'A', email: 'a@example.org' };
  const code1 = service.issueAuthorizationCode(params, identity, 'JWT', ORIGIN).code;
  const foreign = await token.POST(form('/oauth/token', {
    grant_type: 'authorization_code', code: code1, client_id: reg.client_id, redirect_uri: params.redirectUri, code_verifier: verifier,
    resource: 'https://other.example/mcp',
  }));
  check('R-48: token request for a foreign resource → 400 invalid_target', foreign.status === 400 && (await foreign.json()).error === 'invalid_target');
  const code2 = service.issueAuthorizationCode(params, identity, 'JWT', ORIGIN).code;
  const own = await token.POST(form('/oauth/token', {
    grant_type: 'authorization_code', code: code2, client_id: reg.client_id, redirect_uri: params.redirectUri, code_verifier: verifier,
    resource: `${ORIGIN}/mcp`,
  }));
  const tokens = (await own.json()) as { access_token: string; refresh_token: string };
  check('R-48: token request for this server\'s /mcp succeeds', own.status === 200 && tokens.access_token.startsWith('mcp_at_'));

  // ---- 4. revocation endpoint (RFC 7009, R-48) --------------------------------
  const unknown = await revoke.POST(form('/oauth/revoke', { token: 'mcp_rt_nope', client_id: reg.client_id }));
  check('R-48: revoking an unknown token → 200 (RFC 7009 §2.2)', unknown.status === 200);
  const noToken = await revoke.POST(form('/oauth/revoke', { client_id: reg.client_id }));
  check('R-48: revocation without token → 400 invalid_request', noToken.status === 400 && (await noToken.json()).error === 'invalid_request');
  const revoked = await revoke.POST(form('/oauth/revoke', { token: tokens.refresh_token, token_type_hint: 'refresh_token', client_id: reg.client_id }));
  check('R-48: revocation → 200 and the session is gone', revoked.status === 200 && service.verifyAccessToken(tokens.access_token) === undefined);

  // ---- 5. metadata: flags and caching (R-48, R-24) -----------------------------
  const metaReq = () => new Request(`${ORIGIN}/.well-known/oauth-authorization-server`, { headers: { 'x-forwarded-host': 'evil.example' } });
  const derived = await asMeta.GET(metaReq());
  const meta = (await derived.json()) as Record<string, unknown>;
  check('R-48: metadata announces iss in authorization responses (RFC 9207)', meta.authorization_response_iss_parameter_supported === true);
  check('R-48: metadata announces the revocation endpoint', meta.revocation_endpoint === `${meta.issuer}/oauth/revoke`);
  check('R-24: header-derived metadata is not cacheable (no-store)', /no-store/.test(derived.headers.get('cache-control') ?? ''));
  process.env.PUBLIC_BASE_URL = 'https://mcp.example.org/';
  const configured = await asMeta.GET(metaReq());
  check('R-24: with PUBLIC_BASE_URL the issuer ignores X-Forwarded-Host', (await configured.json()).issuer === 'https://mcp.example.org');
  check('R-24: … and the document may be cached', /max-age=300/.test(configured.headers.get('cache-control') ?? ''));

  // ---- 6. one public-URL helper (R-58) -----------------------------------------
  const disco = (await (await mcpJson.GET(new Request(`${ORIGIN}/.well-known/mcp.json`))).json()) as { transport: { url: string } };
  check('R-58: mcp.json uses the normalized origin (no "//mcp" from a trailing slash)', disco.transport.url === 'https://mcp.example.org/mcp');
  check('R-58: resolveIssuer works from bare headers (server components)', resolveIssuer({ headers: new Headers({ host: 'x.example' }) }) === 'https://mcp.example.org');
  delete process.env.PUBLIC_BASE_URL;
  {
    const derivedDisco = await mcpJson.GET(new Request(`${ORIGIN}/.well-known/mcp.json`, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } }));
    check('A-40: header-derived mcp.json is not cacheable (no-store)', /no-store/.test(derivedDisco.headers.get('cache-control') ?? ''));
  }
  check(
    'R-58: without PUBLIC_BASE_URL bare headers resolve via X-Forwarded-*',
    resolveIssuer({ headers: new Headers({ host: 'internal:3000', 'x-forwarded-host': 'wiki.example.org', 'x-forwarded-proto': 'https' }) }) === 'https://wiki.example.org',
  );

  // ---- 7. DCR rate limit per client IP (R-10 rest, R-11) -------------------------
  const ipA = { 'x-forwarded-for': '203.0.113.7' };
  let lastA: Response | undefined;
  for (let i = 0; i < 21; i++) lastA = await register.POST(json('/oauth/register', { redirect_uris: ['https://client.example/cb'] }, ipA));
  check('R-10: the 21st registration from one IP within the window → 429', lastA!.status === 429);
  check('R-10: … with Retry-After', Number(lastA!.headers.get('retry-after')) > 0);
  const ipB = await register.POST(json('/oauth/register', { redirect_uris: ['https://client.example/cb'] }, { 'x-forwarded-for': '203.0.113.8' }));
  check('R-10: another IP is not affected', ipB.status === 201);

  // ---- 8. OAuth off: one shared 404 (R-59) ---------------------------------------
  delete process.env.MCP_SESSION_SECRET;
  const offs = await Promise.all([
    token.POST(form('/oauth/token', {})),
    register.POST(json('/oauth/register', {})),
    revoke.POST(form('/oauth/revoke', {})),
    asMeta.GET(metaReq()),
  ]);
  const texts = await Promise.all(offs.map((r) => r.text()));
  check('R-59: every OAuth endpoint answers 404 with the same text when OAuth is off', offs.every((r) => r.status === 404) && new Set(texts).size === 1);
  const offHealth = await health.GET();
  check('health without OAuth stays 200 (no store to check)', offHealth.status === 200);
  process.env.MCP_SESSION_SECRET = SECRET;

  store.closeStore();
  if (failed === 0) {
    console.log(`\n${pass} oauth-route assertions passed.`);
  } else {
    console.error(`\n${failed} oauth-route assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
