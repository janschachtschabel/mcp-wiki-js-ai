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
});

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

async function main(): Promise<void> {
  const { resolveContext } = await import('../lib/context');
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

  // 3. Unknown token -> verbatim BYOK key, no profile label, URL from header
  const c = h({ 'x-wikijs-token': 'raw-byok-key', 'x-wikijs-url': 'https://other.example' });
  check('byok: no profile label', c.profile === undefined);
  check('byok: url from X-Wikijs-Url header', c.baseUrl === 'https://other.example');
  check('byok: hasToken', c.hasToken === true);

  // 4. Per-request preset can only TIGHTEN (readonly over a redakteur profile)
  const d = h({ 'x-wikijs-token': 'secret-handle-B', 'x-wikijs-preset': 'readonly' });
  check('request preset "readonly" tightens redakteur: write -> block', d.policy.resolve('wiki_page_create', 'write') === 'block');
  check('request preset "readonly": read stays allow', d.policy.resolve('wiki_pages_list', 'read') === 'allow');

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
