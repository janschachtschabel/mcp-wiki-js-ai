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

/** The error message of a rejected promise (or of a synchronous throw inside `fn`), undefined if it resolved. */
async function rejection(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const RESOLVES_INTERNAL = /resolves to an internal address/;

/**
 * Review 2026-10-21 #1: in pure BYOK mode a public-looking NAME may resolve to an
 * internal address (169.254.169.254.nip.io). The WikiClient of a caller-chosen URL
 * checks every resolved address before each request; operator-configured targets
 * (WIKIJS_URL, allow-list) are never looked up. dns.promises.lookup and fetch are
 * stubbed — no real DNS query, no network.
 */
async function dnsRebindingChecks(h: (headers: Record<string, string>) => import('../lib/context').WikiContext): Promise<void> {
  const dns = (await import('node:dns')).default;
  const callerUrl = await import('../lib/caller-url');
  const zone: Record<string, Array<{ address: string; family: number }>> = {
    '169.254.169.254.nip.io': [{ address: '169.254.169.254', family: 4 }],
    'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }],
    'mapped.example': [{ address: '::ffff:127.0.0.1', family: 6 }],
    'nat64.example': [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
    'scoped.example': [{ address: 'fe80::1%eth0', family: 6 }],
    'good.example': [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }],
    'wiki.corp.example': [{ address: '10.0.0.5', family: 4 }],
  };
  const lookups: string[] = [];
  const fetched: string[] = [];
  const realLookup = dns.promises.lookup;
  const realFetch = globalThis.fetch;
  dns.promises.lookup = (async (host: string, opts?: { all?: boolean }) => {
    lookups.push(host);
    const answer = zone[host];
    if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return opts?.all ? answer : answer[0];
  }) as unknown as typeof dns.promises.lookup;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const target = (url: string) => rejection(() => callerUrl.assertPublicTarget(url));
    for (const host of ['169.254.169.254.nip.io', 'mixed.example', 'mapped.example', 'nat64.example', 'scoped.example']) {
      check(`DNS: ${host} resolves to an internal address → refused`, RESOLVES_INTERNAL.test((await target(`http://${host}/`)) ?? ''));
    }
    check('DNS: a name with only public addresses (v4 + v6) passes', (await target('https://good.example/')) === undefined);
    check('DNS: an unresolvable name is refused', /ENOTFOUND/.test((await target('https://nowhere.example/')) ?? ''));
    const before = lookups.length;
    check('DNS: a public IP literal passes without a lookup', (await target('https://172.32.0.1/')) === undefined && lookups.length === before);

    // End to end through resolveContext → WikiClient: nothing is fetched.
    const evil = h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'http://169.254.169.254.nip.io/' });
    check('DNS: pure BYOK download from a name → metadata IP is refused', RESOLVES_INTERNAL.test((await rejection(() => evil.client.download('latest/meta-data'))) ?? ''));
    check('DNS: … GraphQL request refused', RESOLVES_INTERNAL.test((await rejection(() => evil.client.request('query { ok }'))) ?? ''));
    check('DNS: … upload refused', RESOLVES_INTERNAL.test((await rejection(() => evil.client.upload({ filename: 'a.png', data: new Uint8Array([1]) }))) ?? ''));
    check('DNS: … and not a single request left the server', fetched.length === 0);

    const good = h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://good.example' });
    check('DNS: pure BYOK to a public name still works', (await rejection(() => good.client.request('query { ok }'))) === undefined && fetched.length === 1);
    zone['good.example'] = [{ address: '127.0.0.1', family: 4 }]; // the name rebinds
    check('DNS: the check runs before EVERY request (rebinding after the first one is caught)', RESOLVES_INTERNAL.test((await rejection(() => good.client.request('query { ok }'))) ?? '') && fetched.length === 1);

    // Operator-configured targets are trusted as configured — never looked up.
    lookups.length = 0;
    process.env.WIKIJS_URL = 'https://wiki.corp.example';
    check('DNS: WIKIJS_URL resolving to a private address is not checked', (await rejection(() => h({ 'x-wikijs-token': 'k' }).client.request('query { ok }'))) === undefined);
    delete process.env.WIKIJS_URL;
    process.env.WIKIJS_ALLOWED_URLS = 'https://wiki.corp.example';
    const listed = h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://wiki.corp.example' });
    check('DNS: an allow-listed caller URL is not checked either', (await rejection(() => listed.client.request('query { ok }'))) === undefined);
    delete process.env.WIKIJS_ALLOWED_URLS;
    check('DNS: … no lookup for operator-configured targets', lookups.length === 0 && fetched.length === 3);
  } finally {
    dns.promises.lookup = realLookup;
    globalThis.fetch = realFetch;
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
  // Audit R-14b: pure multi-tenant BYOK refuses loopback / private / link-local targets.
  const internalTargets = [
    'http://127.0.0.1:3000',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.1/', // hex 127.0.0.1
    'http://localhost:3000',
    'http://LOCALHOST./',
    'http://wiki.localhost',
    'http://0.0.0.0',
    'http://0/',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.1',
    'http://100.64.0.1',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]',
    'http://[::]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:169.254.169.254]',
    'http://[fe80::1]',
    'http://[fd00::1]',
    'file:///etc/passwd',
    'not a url',
    // benchmarking, multicast, reserved + broadcast, site-local (review 2026-10-21 #3)
    'http://198.18.0.1',
    'http://198.19.255.254',
    'http://224.0.0.1',
    'http://240.0.0.1',
    'http://255.255.255.255',
    'http://[fec0::1]',
    // IPv4 embedded in IPv6: IPv4-compatible ::/96 and NAT64 64:ff9b::/96
    'http://[::7f00:1]',
    'http://[::127.0.0.1]',
    'http://[64:ff9b::7f00:1]',
    'http://[64:ff9b::169.254.169.254]',
    // internal host NAMES (review 2026-10-21 #1): no dot, *.internal, *.local
    'http://wiki',
    'http://db:5432',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://host.docker.internal:3000',
    'http://printer.local',
    'http://WIKI./',
  ];
  for (const target of internalTargets) {
    check(`R-14b: pure BYOK refuses ${target}`, throws(() => h({ 'x-wikijs-token': 'k', 'x-wikijs-url': target })));
  }
  check(
    'R-14b: public IP just outside 172.16/12 is still accepted',
    h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://172.32.0.1' }).baseUrl === 'https://172.32.0.1',
  );
  check(
    'R-14b: public IP just outside 198.18/15 is still accepted',
    h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://198.20.0.1' }).baseUrl === 'https://198.20.0.1',
  );
  check(
    'R-14b: NAT64 address of a PUBLIC IPv4 is still accepted',
    h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://[64:ff9b::808:808]' }).baseUrl === 'https://[64:ff9b::808:808]',
  );
  check(
    'R-14b: a public IPv6 literal is still accepted',
    h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'https://[2001:db8::1]' }).baseUrl === 'https://[2001:db8::1]',
  );
  await dnsRebindingChecks(h);
  // Audit R-14a: a server-side key (KEY_MAP alias) never follows a caller-chosen URL.
  check(
    'R-14a: pure BYOK + KEY_MAP alias + caller url → refused',
    throws(() => h({ 'x-wikijs-token': 'legacy-handle', 'x-wikijs-url': 'https://any.example' })),
  );
  process.env.WIKIJS_ALLOWED_URLS = 'http://localhost:3000';
  check(
    'R-14b: an operator allow-list may still name an internal wiki',
    h({ 'x-wikijs-token': 'k', 'x-wikijs-url': 'http://localhost:3000' }).baseUrl === 'http://localhost:3000',
  );
  delete process.env.WIKIJS_ALLOWED_URLS;
  // Single-tenant env token (no handles, no OAuth) is a server-side key as well.
  const savedP = process.env.WIKIJS_PROFILES;
  const savedK = process.env.WIKIJS_KEY_MAP;
  delete process.env.WIKIJS_PROFILES;
  delete process.env.WIKIJS_KEY_MAP;
  process.env.WIKIJS_TOKEN = 'ENV-SERVICE-TOKEN';
  check(
    'R-14a: env service token + caller url (no WIKIJS_URL) → refused',
    throws(() => h({ 'x-wikijs-url': 'https://attacker.example' })),
  );
  delete process.env.WIKIJS_TOKEN;
  process.env.WIKIJS_PROFILES = savedP;
  process.env.WIKIJS_KEY_MAP = savedK;
  process.env.WIKIJS_URL = savedUrl;

  process.env.WIKIJS_ALLOWED_URLS = 'https://other.example';
  check(
    'R-14a: KEY_MAP alias + allow-listed (but foreign) caller url → refused',
    throws(() => h({ 'x-wikijs-token': 'legacy-handle', 'x-wikijs-url': 'https://other.example' })),
  );
  check(
    'R-14a: KEY_MAP alias + caller url equal to WIKIJS_URL → fine',
    h({ 'x-wikijs-token': 'legacy-handle', 'x-wikijs-url': 'https://wiki.example.org/' }).hasToken === true,
  );
  check(
    'R-14a: raw BYOK key + allow-listed url still works',
    h({ 'x-wikijs-token': 'raw', 'x-wikijs-url': 'https://other.example' }).baseUrl === 'https://other.example',
  );
  delete process.env.WIKIJS_ALLOWED_URLS;

  // 3b. Audit F-02: with OAuth on, the single-tenant env token is never a fallback.
  process.env.WIKIJS_TOKEN = 'ENV-SERVICE-TOKEN';
  process.env.MCP_SESSION_SECRET = 'x'.repeat(32);
  const e = h({ 'x-wikijs-token': '' });
  check('oauth on: empty handle header does NOT pick up WIKIJS_TOKEN', e.hasToken === false);
  delete process.env.MCP_SESSION_SECRET;
  // Audit R-15: with WIKIJS_PROFILES or WIKIJS_KEY_MAP set the deployment is
  // multi-user — an anonymous caller must not borrow the service key.
  check('R-15: profiles set → anonymous caller does NOT get WIKIJS_TOKEN', h({}).hasToken === false);
  const savedProfiles = process.env.WIKIJS_PROFILES;
  const savedKeyMap = process.env.WIKIJS_KEY_MAP;
  delete process.env.WIKIJS_PROFILES;
  check('R-15: key map set → anonymous caller does NOT get WIKIJS_TOKEN', h({}).hasToken === false);
  delete process.env.WIKIJS_KEY_MAP;
  check('oauth off, single-tenant (no profiles/key map): env token is the fallback', h({}).hasToken === true);
  process.env.WIKIJS_PROFILES = savedProfiles;
  process.env.WIKIJS_KEY_MAP = savedKeyMap;
  delete process.env.WIKIJS_TOKEN;

  // 4. Per-request preset can only TIGHTEN (readonly over a redakteur profile)
  const d = h({ 'x-wikijs-token': 'secret-handle-B', 'x-wikijs-preset': 'readonly' });
  check('request preset "readonly" tightens redakteur: write -> block', d.policy.resolve('wiki_page_create', 'write') === 'block');
  check('request preset "readonly": read stays allow', d.policy.resolve('wiki_pages_list', 'read') === 'allow');

  // 4b. Audit R-33: X-Wikijs-Preset AND X-Wikijs-Policy together — both tighten.
  const both = h({
    'x-wikijs-token': 'secret-handle-B',
    'x-wikijs-preset': 'readonly',
    'x-wikijs-policy': JSON.stringify({ tools: { wiki_pages_list: 'confirm' } }),
  });
  check('R-33: preset kept next to policy header → write -> block', both.policy.resolve('wiki_page_create', 'write') === 'block');
  check('R-33: policy header still applies → pages_list -> confirm', both.policy.resolve('wiki_pages_list', 'read') === 'confirm');
  const loosen = h({
    'x-wikijs-token': 'secret-handle-B',
    'x-wikijs-preset': 'readonly',
    'x-wikijs-policy': JSON.stringify({ categories: { write: 'allow' } }),
  });
  check('R-33: policy "write: allow" cannot mask the readonly preset', loosen.policy.resolve('wiki_page_create', 'write') === 'block');
  const oauthPreset = resolveContext({
    requestInfo: { headers: { 'x-wikijs-preset': 'readonly' } },
    authInfo: { token: 'user-jwt', extra: { oauth: true } },
  });
  check('R-33: OAuth session honours X-Wikijs-Preset too → write -> block', oauthPreset.policy.resolve('wiki_page_create', 'write') === 'block');

  // 4c. Characterisation for the R-57 split: OAuth session context.
  const oauth = (extra: Record<string, unknown>, token = 'user-jwt', headers: Record<string, string> = {}) =>
    resolveContext({ requestInfo: { headers }, authInfo: { token, extra: { oauth: true, ...extra } } });
  const o1 = oauth({ sessionId: 'sess-1', label: 'Alice L', email: 'a@example.org' });
  check('oauth: baseUrl from WIKIJS_URL', o1.baseUrl === 'https://wiki.example.org');
  check('oauth: hasToken', o1.hasToken === true);
  check('oauth: profile = label first', o1.profile === 'Alice L');
  check('oauth: profile falls back to email', oauth({ email: 'a@example.org' }).profile === 'a@example.org');
  check('oauth: profile falls back to "oauth-user"', oauth({}).profile === 'oauth-user');
  check('oauth: sessionId passed through', o1.sessionId === 'sess-1' && oauth({}).sessionId === undefined);
  check(
    'oauth: credentialKey is a per-token fingerprint',
    o1.credentialKey !== 'anon' && o1.credentialKey !== oauth({}, 'other-jwt').credentialKey && !o1.credentialKey?.includes('user-jwt'),
  );
  check('oauth: default role "wiki": write -> allow', o1.policy.resolve('wiki_page_create', 'write') === 'allow');
  check('oauth: default role "wiki": delete -> confirm', o1.policy.resolve('wiki_page_delete', 'delete') === 'confirm');
  check('oauth: default role "wiki": wiki_graphql -> block', o1.policy.resolve('wiki_graphql', 'manage_system') === 'block');
  check(
    'oauth: X-Wikijs-Policy tightens',
    oauth({}, 'j', { 'x-wikijs-policy': JSON.stringify({ categories: { write: 'confirm' } }) }).policy.resolve('wiki_page_create', 'write') ===
      'confirm',
  );
  process.env.WIKIJS_OAUTH_ROLE = 'leser';
  check('oauth: WIKIJS_OAUTH_ROLE applied (leser: write -> block)', oauth({}).policy.resolve('wiki_page_create', 'write') === 'block');
  delete process.env.WIKIJS_OAUTH_ROLE;
  const keepUrl = process.env.WIKIJS_URL;
  delete process.env.WIKIJS_URL;
  check('oauth: no WIKIJS_URL → throws', throws(() => oauth({})));
  process.env.WIKIJS_URL = keepUrl;
  check(
    'oauth: authInfo without oauth flag is NOT an OAuth session (legacy path, raw key)',
    resolveContext({ authInfo: { token: 'raw-key', extra: {} } }).sessionId === undefined &&
      resolveContext({ authInfo: { token: 'raw-key', extra: {} } }).profile === undefined,
  );

  // 4d. Characterisation for the R-57 split: legacy credential resolution.
  check('legacy: authInfo token used as credential', resolveContext({ authInfo: { token: 'raw-key' } }).hasToken === true);
  check(
    'legacy: X-Wikijs-Token beats Authorization',
    h({ 'x-wikijs-token': 'secret-handle-A', authorization: 'Bearer secret-handle-B' }).profile === 'Alice',
  );
  check('legacy: no credential → credentialKey "anon", hasToken false', h({}).credentialKey === 'anon' && h({}).hasToken === false);
  check(
    'legacy: authInfo.extra.baseUrl used when no caller url',
    resolveContext({ authInfo: { token: 'raw', extra: { baseUrl: 'https://server-set.example' } } }).baseUrl === 'https://server-set.example',
  );
  const savedProfilesX = process.env.WIKIJS_PROFILES;
  process.env.WIKIJS_PROFILES = JSON.stringify({
    'h-url': { token: 'tok', url: 'https://other-wiki.example', policy: { tools: { wiki_pages_list: 'block' } } },
  });
  const pu = h({ 'x-wikijs-token': 'h-url', 'x-wikijs-url': 'https://ignored.example' });
  check('legacy: profile.url overrides WIKIJS_URL; caller url ignored', pu.baseUrl === 'https://other-wiki.example');
  check('legacy: unlabeled profile → "(unlabeled)"', pu.profile === '(unlabeled)');
  check('legacy: profile inline policy applied', pu.policy.resolve('wiki_pages_list', 'read') === 'block');
  process.env.WIKIJS_PROFILES = savedProfilesX;
  delete process.env.WIKIJS_URL;
  check('legacy: no URL anywhere → throws', throws(() => h({ 'x-wikijs-token': 'raw' })));
  process.env.WIKIJS_URL = keepUrl;

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
