/**
 * Offline tests for credential/context resolution (lib/context.ts):
 * profile handle -> label+role (secret NEVER echoed), BYOK passthrough, per-request tightening.
 * No network — resolveContext only builds the context object.
 *
 * Env is set BEFORE importing context.ts (its BASE_POLICY is built at import time), so the
 * import is dynamic inside main().  Run: npm run test:ctx
 */
process.env.WIKIJS_URL = 'https://wiki.example.org';
process.env.WIKIJS_PERMISSION_PRESET = 'systemadmin'; // ceiling = allow everything
process.env.WIKIJS_PROFILES = JSON.stringify({
  'secret-handle-A': { label: 'Alice', token: 'real-key-A', role: 'leser' },
  'secret-handle-B': { label: 'Bob', token: 'real-key-B', role: 'redakteur' },
  'secret-handle-C': { label: 'Carol', token: 'real-key-C' }, // no role → defaultRole
  'secret-handle-D': { label: 'Dave', token: 'real-key-D', role: 'redakter' }, // typo
});
process.env.WIKIJS_KEY_MAP = JSON.stringify({ 'legacy-handle': 'real-key-E' });

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

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const { resolveContext, toolExtraFromServerContext } = await import('../lib/context');
  const h = (headers: Record<string, string>) => resolveContext({ requestInfo: { headers } });

  // 1. Profile handle (via X-Wikijs-Token) -> label exposed, secret NEVER echoed, role applied
  const a = h({ 'x-wikijs-token': 'secret-handle-A' });
  check('profile A: label "Alice" exposed (not the secret handle)', a.profile === 'Alice');
  check('profile A: secret handle is NOT echoed as profile', a.profile !== 'secret-handle-A');
  check('profile A: baseUrl from global WIKIJS_URL', a.baseUrl === 'https://wiki.example.org');
  check('profile A: hasToken (real key resolved server-side)', a.hasToken === true);
  check('profile A (leser): write -> block', a.policy.resolve('wiki_page_create', 'write') === 'block');
  check('profile A (leser): read -> allow', a.policy.resolve('wiki_pages_list', 'read') === 'allow');

  // 2. Profile handle (via Authorization: Bearer) -> redakteur role
  const b = h({ authorization: 'Bearer secret-handle-B' });
  check('profile B: label "Bob"', b.profile === 'Bob');
  check('profile B (redakteur): write -> allow', b.policy.resolve('wiki_page_create', 'write') === 'allow');
  check('profile B (redakteur): delete -> confirm', b.policy.resolve('wiki_page_delete', 'delete') === 'confirm');

  // 2b. Audit R-03: a missing role gets defaultRole ("safe"), never the systemadmin ceiling;
  // an unknown role fails closed instead of silently granting the ceiling.
  const carol = h({ 'x-wikijs-token': 'secret-handle-C' });
  check('profile C (no role → safe): write -> confirm', carol.policy.resolve('wiki_page_create', 'write') === 'confirm');
  check('profile C (no role → safe): manage_users -> block', carol.policy.resolve('wiki_user_create', 'manage_users') === 'block');
  check('profile D (unknown role "redakter") → throws', throws(() => h({ 'x-wikijs-token': 'secret-handle-D' })));
  const legacy = h({ 'x-wikijs-token': 'legacy-handle' });
  check('KEY_MAP alias (server key, no role) → defaultRole: write -> confirm', legacy.policy.resolve('wiki_page_create', 'write') === 'confirm');

  // 3. Unknown token -> verbatim BYOK key, no profile label.
  // A caller-supplied URL is only honoured when allow-listed (audit F-01: SSRF).
  process.env.WIKIJS_ALLOWED_URLS = 'https://other.example, https://third.example/';
  const c = h({ 'x-wikijs-token': 'raw-byok-key', 'x-wikijs-url': 'https://other.example' });
  check('byok: no profile label', c.profile === undefined);
  check('byok: allow-listed url from X-Wikijs-Url header', c.baseUrl === 'https://other.example');
  check('byok: hasToken', c.hasToken === true);
  check(
    'byok: allow-list matches by origin (trailing slash in list)',
    h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://third.example' }).baseUrl === 'https://third.example',
  );
  check(
    'byok: url outside the allow-list is refused',
    throws(() => h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'http://169.254.169.254/latest' })),
  );
  delete process.env.WIKIJS_ALLOWED_URLS;
  check(
    'byok: no allow-list + WIKIJS_URL set → header url refused',
    throws(() => h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://other.example' })),
  );
  check(
    'byok: header url equal to WIKIJS_URL is fine',
    h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://wiki.example.org/' }).baseUrl === 'https://wiki.example.org/',
  );
  const savedUrl = process.env.WIKIJS_URL;
  delete process.env.WIKIJS_URL;
  check(
    'byok: pure multi-tenant (no WIKIJS_URL, no allow-list) keeps header url',
    h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://any.example' }).baseUrl === 'https://any.example',
  );
  process.env.WIKIJS_URL = savedUrl;

  // 3b. Audit F-02: with OAuth on, the single-tenant env token is never a fallback.
  process.env.WIKIJS_TOKEN = 'ENV-SERVICE-TOKEN';
  process.env.MCP_SESSION_SECRET = 'x'.repeat(32);
  const e = h({ 'x-wikijs-token': '' });
  check('oauth on: empty handle header does NOT pick up WIKIJS_TOKEN', e.hasToken === false);
  delete process.env.MCP_SESSION_SECRET;
  check('oauth off: env token still used as single-tenant fallback', h({}).hasToken === true);
  delete process.env.WIKIJS_TOKEN;

  // 4. Per-request preset can only TIGHTEN (readonly over a redakteur profile)
  const d = h({ 'x-wikijs-token': 'secret-handle-B', 'x-wikijs-preset': 'readonly' });
  check('request preset "readonly" tightens redakteur: write -> block', d.policy.resolve('wiki_page_create', 'write') === 'block');
  check('request preset "readonly": read stays allow', d.policy.resolve('wiki_pages_list', 'read') === 'allow');

  // 5. MCP SDK v2 handler context (ctx.http.req / ctx.http.authInfo) → ToolExtra.
  const v2 = toolExtraFromServerContext({
    http: {
      req: new Request('https://mcp.example/mcp', { headers: { 'X-Wikijs-Token': 'secret-handle-A' } }),
      authInfo: { token: 'jwt', extra: { oauth: true } },
    },
  });
  check('sdk v2 ctx: headers lower-cased into requestInfo', v2.requestInfo?.headers?.['x-wikijs-token'] === 'secret-handle-A');
  check('sdk v2 ctx: authInfo passed through', v2.authInfo?.token === 'jwt');
  check('sdk v2 ctx: profile resolves via adapted headers', resolveContext({ requestInfo: v2.requestInfo }).profile === 'Alice');
  check('sdk v2 ctx: no http (stdio) → empty extra', toolExtraFromServerContext({}).requestInfo === undefined);

  if (failed === 0) {
    console.log(`\n${pass} context-resolution assertions passed.`);
  } else {
    console.error(`\n${failed} context assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
