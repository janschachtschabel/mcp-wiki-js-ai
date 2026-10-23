/**
 * Offline tests for the startup configuration check (lib/config-check.ts) and the
 * fail-closed session-secret handling (audit R-03, R-07). Pure logic, no network.
 * Run: npm run test:config
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

import { checkConfig, assertConfig } from '../lib/config-check';
import { sessionSecret, oauthEnabled } from '../lib/oauth/crypto';

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

function throws(fn: () => unknown, re?: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return re ? re.test(e instanceof Error ? e.message : String(e)) : true;
  }
}

const SECRET = 'x'.repeat(32);
const errs = (env: Record<string, string | undefined>) => checkConfig(env).errors;
const hasErr = (env: Record<string, string | undefined>, re: RegExp) => errs(env).some((e) => re.test(e));

// 1. A plain / empty configuration is valid.
check('empty env → no errors', errs({}).length === 0);
check(
  'typical OAuth env → no errors',
  errs({ MCP_SESSION_SECRET: SECRET, PUBLIC_BASE_URL: 'https://wiki.example.org', WIKIJS_OAUTH_ROLE: 'wiki', WIKIJS_PERMISSION_PRESET: 'full' }).length === 0,
);

// 2. R-07: a SET but too-short secret is a hard error, not a silent legacy fallback.
check('MCP_SESSION_SECRET < 16 chars → error', hasErr({ MCP_SESSION_SECRET: 'short' }, /MCP_SESSION_SECRET/));
check('MCP_SESSION_SECRET whitespace-only → treated as unset (no error)', errs({ MCP_SESSION_SECRET: '   ' }).length === 0);
check('sessionSecret(): unset → undefined', sessionSecret({}) === undefined);
check('sessionSecret(): valid → trimmed value', sessionSecret({ MCP_SESSION_SECRET: ` ${SECRET} ` }) === SECRET);
check('sessionSecret(): set but short → throws', throws(() => sessionSecret({ MCP_SESSION_SECRET: 'short' }), /16/));
check('oauthEnabled(): reflects a valid secret', oauthEnabled({ MCP_SESSION_SECRET: SECRET }) && !oauthEnabled({}));

// 3. R-03: unknown role names are errors wherever a role can be configured.
check('WIKIJS_OAUTH_ROLE typo ("Wiki") → error', hasErr({ WIKIJS_OAUTH_ROLE: 'Wiki' }, /WIKIJS_OAUTH_ROLE/));
check('WIKIJS_PERMISSION_PRESET unknown → error', hasErr({ WIKIJS_PERMISSION_PRESET: 'fulll' }, /WIKIJS_PERMISSION_PRESET/));
check('WIKIJS_PERMISSION_PRESET is case-insensitive like basePolicyFromEnv', errs({ WIKIJS_PERMISSION_PRESET: 'Full' }).length === 0);

const profiles = (map: unknown) => ({ WIKIJS_PROFILES: JSON.stringify(map) });
check(
  'profile with unknown role → error',
  hasErr(profiles({ 'secret-h': { label: 'Alice', token: 't', role: 'redakter' } }), /redakter/),
);
check(
  'profile error names the label, never the secret handle',
  errs(profiles({ 'secret-h': { label: 'Alice', token: 't', role: 'redakter' } })).every((e) => !e.includes('secret-h')),
);
check('profile with unknown legacy "preset" → error', hasErr(profiles({ h: { token: 't', preset: 'nope' } }), /nope/));
check('profile without token → error', hasErr(profiles({ h: { label: 'Bob', role: 'leser' } }), /token/));
check('profile without role is valid (gets defaultRole)', errs(profiles({ h: { token: 't' } })).length === 0);

// 4. Broken JSON in any policy/credential map is an error (was silently ignored).
check('WIKIJS_PROFILES invalid JSON → error', hasErr({ WIKIJS_PROFILES: '{nope' }, /WIKIJS_PROFILES/));
check('WIKIJS_PROFILES not an object → error', hasErr({ WIKIJS_PROFILES: '[]' }, /WIKIJS_PROFILES/));
check('WIKIJS_ROLES invalid JSON → error', hasErr({ WIKIJS_ROLES: '{nope' }, /WIKIJS_ROLES/));
check('WIKIJS_KEY_MAP invalid JSON → error', hasErr({ WIKIJS_KEY_MAP: '{nope' }, /WIKIJS_KEY_MAP/));
check('WIKIJS_POLICY invalid JSON → error', hasErr({ WIKIJS_POLICY: '{nope' }, /WIKIJS_POLICY/));

// 5. OAuth without PUBLIC_BASE_URL works (X-Forwarded-* fallback) but is warned about.
check(
  'OAuth without PUBLIC_BASE_URL → warning, not error',
  checkConfig({ MCP_SESSION_SECRET: SECRET }).warnings.some((w) => /PUBLIC_BASE_URL/.test(w)) &&
    errs({ MCP_SESSION_SECRET: SECRET }).length === 0,
);

// 5b. A public URL without a session secret looks like a broken OAuth setup (e.g. a
// mistyped key in an existing K8s Secret). With WIKIJS_TOKEN present, /mcp would
// then serve anonymous callers with the service key — warn loudly.
check(
  'PUBLIC_BASE_URL + WIKIJS_TOKEN without MCP_SESSION_SECRET → warning (OAuth is off)',
  checkConfig({ PUBLIC_BASE_URL: 'https://wiki.example.org', WIKIJS_TOKEN: 'svc' }).warnings.some(
    (w) => /OAuth is OFF/.test(w) && /WIKIJS_TOKEN/.test(w),
  ),
);
check(
  'plain single-tenant (no PUBLIC_BASE_URL) → no OAuth warning',
  !checkConfig({ WIKIJS_TOKEN: 'svc' }).warnings.some((w) => /OAuth is OFF/.test(w)),
);
// 5c. Audit R-15: with profiles / a key map the env token is no anonymous fallback.
check(
  'R-15: PUBLIC_BASE_URL + WIKIJS_TOKEN + WIKIJS_PROFILES → no "serves unauthenticated callers" claim',
  !checkConfig({ PUBLIC_BASE_URL: 'https://wiki.example.org', WIKIJS_TOKEN: 'svc', WIKIJS_PROFILES: '{"h":{"token":"t"}}' }).warnings.some(
    (w) => /unauthenticated callers/.test(w),
  ),
);
check(
  'R-15: WIKIJS_TOKEN + WIKIJS_KEY_MAP → warning that the env token is not an anonymous fallback',
  checkConfig({ WIKIJS_TOKEN: 'svc', WIKIJS_KEY_MAP: '{"h":"t"}' }).warnings.some((w) => /WIKIJS_TOKEN/.test(w) && /anonymous/.test(w)),
);

// 5d. Audit R-14a: a KEY_MAP server key is only ever sent to WIKIJS_URL.
check(
  'R-14a: WIKIJS_KEY_MAP without WIKIJS_URL → warning',
  checkConfig({ WIKIJS_KEY_MAP: '{"h":"t"}' }).warnings.some((w) => /WIKIJS_KEY_MAP/.test(w) && /WIKIJS_URL/.test(w)),
);
check(
  'R-14a: WIKIJS_KEY_MAP with WIKIJS_URL → no such warning',
  !checkConfig({ WIKIJS_KEY_MAP: '{"h":"t"}', WIKIJS_URL: 'https://wiki.example.org' }).warnings.some((w) => /WIKIJS_KEY_MAP/.test(w)),
);

// 5e. Review 2026-10-21 #1: pure BYOK lets callers pick the target wiki — say so at startup.
{
  const byok = (env: Record<string, string | undefined>) => checkConfig(env).warnings.some((w) => /reines BYOK/.test(w));
  const w = checkConfig({}).warnings.find((x) => /reines BYOK/.test(x)) ?? '';
  check(
    'pure BYOK (no WIKIJS_URL, no allow-list, no OAuth) → warning naming DNS rebinding and the fix',
    /DNS-Rebinding/.test(w) && /WIKIJS_URL/.test(w) && /WIKIJS_ALLOWED_URLS/.test(w),
  );
  check('pure BYOK warning: not with WIKIJS_URL', !byok({ WIKIJS_URL: 'https://wiki.example.org' }));
  check('pure BYOK warning: not with WIKIJS_BASE_URL', !byok({ WIKIJS_BASE_URL: 'https://wiki.example.org' }));
  check('pure BYOK warning: not with WIKIJS_ALLOWED_URLS', !byok({ WIKIJS_ALLOWED_URLS: 'https://a.example' }));
  check('pure BYOK warning: not with OAuth on', !byok({ MCP_SESSION_SECRET: SECRET }));
  check('pure BYOK warning: an allow-list of blanks still counts as none', byok({ WIKIJS_ALLOWED_URLS: ' , ' }));
  check('pure BYOK warning: not in stdio', !checkConfig({}, { stdio: true }).warnings.some((x) => /reines BYOK/.test(x)));
}

// 5c. stdio never runs OAuth: OAuth/HTTP-only settings from a shared .env must neither
// abort it nor produce misleading warnings — but checks that apply to stdio still do.
{
  const shared = {
    MCP_SESSION_SECRET: 'too-short', PUBLIC_BASE_URL: 'https://wiki.example.org',
    WIKIJS_OAUTH_ROLE: 'Wikki', WIKIJS_TOKEN: 'svc', WIKIJS_PROFILES: '{}',
  };
  const r = checkConfig(shared, { stdio: true });
  check('stdio: short MCP_SESSION_SECRET / unknown OAuth role do not abort', r.errors.length === 0);
  check('stdio: no OAuth/HTTP warnings', r.warnings.length === 0);
  check(
    'stdio: unknown WIKIJS_PERMISSION_PRESET is still an error',
    checkConfig({ WIKIJS_PERMISSION_PRESET: 'nope' }, { stdio: true }).errors.length === 1,
  );
  check('HTTP (default): the same shared .env still aborts', checkConfig(shared).errors.length > 0);
}

// Audit 2026-10-23: A-22 (weak secret) and A-03 (open client registration).
const warns = (env: Record<string, string | undefined>) => checkConfig(env).warnings;
check('A-22: a 16–31 character secret is accepted but warned about', errs({ MCP_SESSION_SECRET: 'y'.repeat(20) }).length === 0 && warns({ MCP_SESSION_SECRET: 'y'.repeat(20) }).some((w) => /32/.test(w) && /MCP_SESSION_SECRET/.test(w)));
check('A-22: a 32+ character secret is not warned about', !warns({ MCP_SESSION_SECRET: SECRET }).some((w) => /MCP_SESSION_SECRET is shorter/.test(w)));
check('A-03: OAuth without MCP_ALLOWED_REDIRECT_HOSTS warns about open registration', warns({ MCP_SESSION_SECRET: SECRET }).some((w) => /MCP_ALLOWED_REDIRECT_HOSTS/.test(w)));
check('A-03: no warning once the allowlist is set', !warns({ MCP_SESSION_SECRET: SECRET, MCP_ALLOWED_REDIRECT_HOSTS: 'claude.ai' }).some((w) => /MCP_ALLOWED_REDIRECT_HOSTS/.test(w)));
check('A-03: no allowlist warning without OAuth', !warns({}).some((w) => /MCP_ALLOWED_REDIRECT_HOSTS/.test(w)));

// 6. assertConfig aborts with ALL errors in one message.
check(
  'assertConfig throws listing every error',
  throws(() => assertConfig({ MCP_SESSION_SECRET: 'short', WIKIJS_OAUTH_ROLE: 'Wiki' }, () => {}), /MCP_SESSION_SECRET[\s\S]*WIKIJS_OAUTH_ROLE/),
);
check('assertConfig passes a valid env', !throws(() => assertConfig({}, () => {})));

if (failed === 0) {
  console.log(`\n${pass} config assertions passed.`);
} else {
  console.error(`\n${failed} config assertion(s) FAILED.`);
  process.exit(1);
}
