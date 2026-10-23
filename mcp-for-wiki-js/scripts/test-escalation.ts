/**
 * Offline tests for the policy bypasses found in the re-audit, against stubbed
 * Wiki.js clients (no network):
 *  - R-04 wiki_graphql: blocked in every role except systemadmin/full; raw
 *    mutations are detected by parsing, not by regex
 *  - R-05 wiki_asset_download: only asset paths, no HTML, no redirects
 *  - R-12 users.create/update: assigning groups needs manage_groups
 * Run: npm run test:escalation
 */
export {}; // module scope — keeps `pass`/`failed` from colliding with the other test scripts

import type { WikiContext } from '../lib/context';
import type { ToolDef } from '../lib/tools/types';
import { ROLES, basePolicyFromEnv, roleConfig } from '../lib/permissions';
import { WikiClient } from '../lib/wikijs/client';
import { GuardrailError } from '../lib/guardrails';
import { isDryRun } from '../lib/wikijs/format';

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

const ceiling = basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'systemadmin' });
const policyFor = (role: string) => ceiling.withOverlay(roleConfig(role));

interface Calls {
  requests: string[];
  downloads: string[];
}

interface StubOpts {
  mime?: string;
  /** users.single answer for the target-account lookup (A-10); null = no such user. */
  target?: { isSystem: boolean; groups: { id: number; permissions: string[] }[] } | null;
  lookupFails?: boolean;
  /** Answer for queries the stub does not know (default { ok: true }). */
  fallback?: unknown;
}

const PLAIN_USER = { isSystem: false, groups: [{ id: 3, permissions: ['read:pages', 'write:pages'] }] };
const ADMIN_USER = { isSystem: false, groups: [{ id: 1, permissions: ['manage:system'] }] };

function stubCtx(role: string, opts: StubOpts = {}): { ctx: WikiContext; calls: Calls } {
  const calls: Calls = { requests: [], downloads: [] };
  const ctx = {
    client: {
      request: async (q: string) => {
        calls.requests.push(q);
        if (q.includes('users { single')) {
          if (opts.lookupFails) throw new Error('Forbidden');
          return { users: { single: opts.target === undefined ? PLAIN_USER : opts.target } };
        }
        if (q.includes('disableTFA')) return { users: { disableTFA: { responseResult: { succeeded: true } } } };
        if (q.includes('createApiKey')) return { authentication: { createApiKey: { responseResult: { succeeded: true }, key: 'new-key' } } };
        if (q.includes('users { create')) return { users: { create: { responseResult: { succeeded: true }, user: { id: 7 } } } };
        if (q.includes('users { update')) return { users: { update: { responseResult: { succeeded: true } } } };
        if (q.includes('pages { create')) return { pages: { create: { responseResult: { succeeded: true }, page: { id: 1 } } } };
        if (q.includes('pages { update')) return { pages: { update: { responseResult: { succeeded: true }, page: { id: 1 } } } };
        if (q.includes('single(id:$id)')) {
          return {
            pages: {
              single: {
                path: 'a', locale: 'en', title: 'A', description: '', editor: 'markdown', isPublished: true,
                isPrivate: false, content: 'x', tags: [], scriptCss: 'old-css', scriptJs: 'old-js',
              },
            },
          };
        }
        return opts.fallback ?? { ok: true };
      },
      download: async (path: string) => {
        calls.downloads.push(path);
        return { data: new TextEncoder().encode('x'), mime: opts.mime ?? 'image/png' };
      },
    },
    policy: policyFor(role),
    baseUrl: 'https://wiki.example.org',
    hasToken: true,
    credentialKey: 'test',
  } as unknown as WikiContext;
  return { ctx, calls };
}

/** A handler outcome; a thrown refusal counts as isError (register.ts turns it into fail()). */
async function settle(p: Promise<{ isError?: boolean }>): Promise<{ isError: boolean; guardrail: boolean }> {
  try {
    return { isError: (await p).isError === true, guardrail: false };
  } catch (e) {
    return { isError: true, guardrail: e instanceof GuardrailError };
  }
}

async function main(): Promise<void> {
  const { allTools } = await import('../lib/tools/index');
  const tool = (name: string): ToolDef => allTools.find((t) => t.name === name)!;

  // ---- R-04: wiki_graphql only for systemadmin ------------------------------
  for (const role of Object.keys(ROLES).sort()) {
    const expected = role === 'systemadmin' || role === 'full' ? 'allow' : 'block';
    check(`R-04: role ${role}: wiki_graphql -> ${expected}`, policyFor(role).resolve('wiki_graphql', 'manage_system') === expected);
  }

  const gql = tool('wiki_graphql');
  const runGql = async (query: string, confirm?: boolean) => {
    const { ctx, calls } = stubCtx('systemadmin');
    const res = await gql.handler({ query, ...(confirm ? { confirm } : {}) }, ctx);
    return { res, executed: calls.requests.length > 0 };
  };
  const dryRun = (r: { res: { content: unknown[] }; executed: boolean }) =>
    !r.executed && JSON.stringify(r.res.content).includes('DRY RUN');

  check('R-04: plain mutation without confirm -> dry run', dryRun(await runGql('mutation { pages { delete(id: 1) { responseResult { succeeded } } } }')));
  check('R-04: ",mutation{…}" (comma is an ignored token) -> dry run', dryRun(await runGql(',mutation{pages{delete(id:1){responseResult{succeeded}}}}')));
  check('R-04: comment before mutation -> dry run', dryRun(await runGql('# just a read\nmutation{pages{delete(id:1){responseResult{succeeded}}}}')));
  check('R-04: query + mutation in one document -> dry run', dryRun(await runGql('query A { site { config { title } } } mutation B { pages { delete(id: 1) { responseResult { succeeded } } } }')));
  check('R-04: subscription -> dry run', dryRun(await runGql('subscription { loggingLiveTrail { level } }')));
  check('R-04: field NAMED "mutation" inside a query still runs', (await runGql('{ site { mutation: config { title } } }')).executed);
  check('R-04: plain query runs', (await runGql('{ site { config { title } } }')).executed);
  check('R-04: mutation with confirm runs', (await runGql('mutation { pages { delete(id: 1) { responseResult { succeeded } } } }', true)).executed);
  const broken = await runGql('mutation { pages { delete(id: 1) ');
  check('R-04: unparsable document -> error, not executed', broken.res.isError === true && !broken.executed);

  // ---- R-05: wiki_asset_download only fetches asset paths -------------------
  const dl = tool('wiki_asset_download');
  const tryPath = async (path: string, mime?: string) => {
    const { ctx, calls } = stubCtx('leser', { mime });
    const res = await dl.handler({ path, maxBytes: 1_000_000 }, ctx);
    return { res, fetched: calls.downloads.length > 0 };
  };
  for (const bad of [
    'graphql',
    '/graphql',
    'graphql?query={users{list{email}}}',
    's/en/home',
    'd/en/home',
    'h/en/home',
    'uploads/a.png?x=1',
    'uploads/a.png#frag',
    'uploads/../graphql',
    'uploads/%2e%2e/graphql',
    'uploads/a%3Fquery.png',
    'uploads\\..\\graphql',
    'login',
  ]) {
    const r = await tryPath(bad);
    check(`R-05: "${bad}" rejected before any request`, r.res.isError === true && !r.fetched);
  }
  check('R-05: normal asset path is fetched', (await tryPath('uploads/diagram.png')).fetched);
  check('R-05: nested asset folder is fetched', (await tryPath('/docs/img/a-b_c.v2.png')).fetched);
  const html = await tryPath('uploads/page', 'text/html; charset=utf-8');
  check('R-05: text/html response (rendered page) is refused', html.res.isError === true);

  // The real client must not follow redirects (a redirect could lead off the asset space).
  const realFetch = globalThis.fetch;
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen = init;
    return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  try {
    await new WikiClient('https://wiki.example.org', 't').download('uploads/a.png', 100);
  } finally {
    globalThis.fetch = realFetch;
  }
  check("R-05: client.download uses redirect: 'error'", seen?.redirect === 'error');

  // ---- R-12: groups via users.* need manage_groups ---------------------------
  const create = tool('wiki_user_create');
  const update = tool('wiki_user_update');
  const userArgs = { email: 'new@example.org', name: 'New', providerKey: 'local', mustChangePassword: false, sendWelcomeEmail: false };

  // moderator: manage_users=confirm, manage_groups=block
  let s = stubCtx('moderator');
  const createAdmin = await settle(create.handler({ ...userArgs, groups: [1], confirm: true }, s.ctx));
  check('R-12: moderator create with groups -> refused', createAdmin.isError === true && s.calls.requests.length === 0);
  check('#2: the refusal is a GuardrailError (audited "blocked")', createAdmin.guardrail);
  s = stubCtx('moderator');
  check('R-12: moderator create without groups -> runs', !(await create.handler({ ...userArgs, groups: [], confirm: true }, s.ctx)).isError && s.calls.requests.length > 0);
  s = stubCtx('moderator');
  const updAdmin = await settle(update.handler({ id: 2, groups: [1], confirm: true }, s.ctx));
  check('R-12: moderator update with groups -> refused', updAdmin.isError === true && s.calls.requests.length === 0);
  s = stubCtx('moderator');
  const strip = await settle(update.handler({ id: 2, groups: [], confirm: true }, s.ctx));
  check('R-12: moderator update with groups: [] (strips memberships) -> refused', strip.isError === true && s.calls.requests.length === 0);
  s = stubCtx('moderator');
  check('R-12: moderator update without groups -> runs', !(await update.handler({ id: 2, name: 'x', confirm: true }, s.ctx)).isError && s.calls.requests.length > 0);

  // admin: manage_groups=confirm → groups need an explicit confirm
  s = stubCtx('admin');
  const preview = await update.handler({ id: 2, groups: [1] }, s.ctx);
  check('R-12: admin update with groups, no confirm -> preview, nothing sent', !preview.isError && s.calls.requests.length === 0);
  check('#2: the parameter dry run is marked _meta.dryRun', (preview._meta as { dryRun?: boolean } | undefined)?.dryRun === true);
  s = stubCtx('admin');
  check('R-12: admin update with groups + confirm -> runs', !(await update.handler({ id: 2, groups: [1], confirm: true }, s.ctx)).isError && s.calls.requests.length > 0);
  s = stubCtx('systemadmin');
  check('R-12: systemadmin create with groups -> runs', !(await create.handler({ ...userArgs, groups: [1] }, s.ctx)).isError && s.calls.requests.length > 0);

  // ---- R-18: page scripts need manage_system -----------------------------------
  const pCreate = tool('wiki_page_create');
  const pUpdate = tool('wiki_page_update');
  const pageArgs = { path: 'docs/x', title: 'X', content: 'body', description: '', editor: 'markdown', locale: 'en', tags: [], isPublished: true, isPrivate: false };
  const mutated = (c: Calls) => c.requests.some((q) => q.startsWith('mutation'));

  // autor: write=allow, manage_system=block
  s = stubCtx('autor');
  const xss = await settle(pCreate.handler({ ...pageArgs, scriptJs: 'alert(1)', confirm: true }, s.ctx));
  check('R-18: autor create with scriptJs -> refused, nothing sent', xss.isError === true && s.calls.requests.length === 0);
  check('#2: the script refusal is a GuardrailError (audited "blocked")', xss.guardrail);
  s = stubCtx('autor');
  const css = await settle(pUpdate.handler({ id: 1, scriptCss: 'body{}', confirm: true }, s.ctx));
  check('R-18: autor update with scriptCss -> refused, nothing written', css.isError === true && !mutated(s.calls));
  s = stubCtx('autor');
  check('R-18: autor create without scripts -> runs', !(await pCreate.handler(pageArgs, s.ctx)).isError && mutated(s.calls));
  s = stubCtx('autor');
  check('R-18: autor content update (scripts carried over, not set) -> runs', !(await pUpdate.handler({ id: 1, content: 'new' }, s.ctx)).isError && mutated(s.calls));
  // betreuer: manage_system=confirm
  s = stubCtx('betreuer');
  const scriptPreview = await pCreate.handler({ ...pageArgs, scriptJs: 'x()' }, s.ctx);
  check('R-18: betreuer create with scriptJs, no confirm -> preview, nothing sent', !scriptPreview.isError && JSON.stringify(scriptPreview.content).includes('DRY RUN') && s.calls.requests.length === 0);
  s = stubCtx('betreuer');
  check('R-18: betreuer create with scriptJs + confirm -> runs', !(await pCreate.handler({ ...pageArgs, scriptJs: 'x()', confirm: true }, s.ctx)).isError && mutated(s.calls));
  s = stubCtx('systemadmin');
  check('R-18: systemadmin create with scriptJs -> runs', !(await pCreate.handler({ ...pageArgs, scriptJs: 'x()' }, s.ctx)).isError && mutated(s.calls));

  // ---- R-19: no password echo ---------------------------------------------------
  s = stubCtx('systemadmin');
  const reset = await tool('wiki_user_reset_password').handler({ id: 2, newPassword: 'Very-Secret-123' }, s.ctx);
  check('R-19: reset_password does not echo a caller-supplied password', !reset.isError && !JSON.stringify(reset).includes('Very-Secret-123'));
  s = stubCtx('systemadmin');
  const created = await create.handler({ ...userArgs, groups: [], passwordRaw: 'Init-Secret-456' }, s.ctx);
  check('R-19: user_create does not echo passwordRaw', !created.isError && !JSON.stringify(created).includes('Init-Secret-456'));

  // ---- A-10: manage_users must not take over privileged accounts -----------------
  const uUpdate = tool('wiki_user_update');
  const uReset = tool('wiki_user_reset_password');
  const uTfa = tool('wiki_user_disable_tfa');
  s = stubCtx('moderator', { target: ADMIN_USER });
  const pwAdmin = await settle(uUpdate.handler({ id: 1, newPassword: 'Takeover-123', confirm: true }, s.ctx));
  check('A-10: moderator sets the password of an admin -> refused (GuardrailError), nothing written', pwAdmin.guardrail && !mutated(s.calls));
  s = stubCtx('moderator', { target: ADMIN_USER });
  const mailAdmin = await settle(uUpdate.handler({ id: 1, email: 'evil@example.org', confirm: true }, s.ctx));
  check('A-10: moderator changes the e-mail of an admin -> refused', mailAdmin.guardrail && !mutated(s.calls));
  s = stubCtx('moderator', { target: ADMIN_USER });
  check('A-10: moderator renames an admin (no credential field) -> runs', !(await uUpdate.handler({ id: 1, name: 'Boss', confirm: true }, s.ctx)).isError && mutated(s.calls));
  s = stubCtx('moderator', { target: ADMIN_USER });
  const resetAdmin = await settle(uReset.handler({ id: 1, confirm: true }, s.ctx));
  check('A-10: moderator resets an admin password -> refused', resetAdmin.guardrail && !mutated(s.calls));
  s = stubCtx('moderator', { target: ADMIN_USER });
  const tfaAdmin = await settle(uTfa.handler({ id: 1, confirm: true }, s.ctx));
  check('A-10: moderator disables 2FA of an admin -> refused', tfaAdmin.guardrail && !mutated(s.calls));
  s = stubCtx('moderator', { target: { isSystem: false, groups: [{ id: 5, permissions: ['manage:users'] }] } });
  const customAdmin = await settle(uReset.handler({ id: 4, confirm: true }, s.ctx));
  check('A-10: a custom group with manage:users counts as privileged', customAdmin.guardrail && !mutated(s.calls));
  s = stubCtx('moderator', { lookupFails: true });
  const unknown = await settle(uReset.handler({ id: 4, confirm: true }, s.ctx));
  check('A-10: an unreadable target account fails closed', unknown.guardrail && !mutated(s.calls));
  s = stubCtx('moderator');
  check('A-10: moderator resets the password of a normal user -> runs', !(await uReset.handler({ id: 3, confirm: true }, s.ctx)).isError && mutated(s.calls));
  s = stubCtx('moderator');
  check('A-10: moderator disables 2FA of a normal user -> runs', !(await uTfa.handler({ id: 3, confirm: true }, s.ctx)).isError && mutated(s.calls));
  s = stubCtx('admin', { target: ADMIN_USER });
  const adminPreview = await uReset.handler({ id: 1 }, s.ctx);
  check('A-10: admin (manage_groups confirm) on an admin target, no confirm -> dry run, nothing written', !adminPreview.isError && isDryRun(adminPreview) && !mutated(s.calls));
  s = stubCtx('admin', { target: ADMIN_USER });
  check('A-10: … with confirm -> runs', !(await uReset.handler({ id: 1, confirm: true }, s.ctx)).isError && mutated(s.calls));
  s = stubCtx('systemadmin', { target: ADMIN_USER });
  check('A-10: systemadmin needs no target lookup', !(await uReset.handler({ id: 1 }, s.ctx)).isError && !s.calls.requests.some((q) => q.includes('users { single')));

  // ---- A-12: tag maintenance, render and purge need manage:system in Wiki.js ------
  for (const name of ['wiki_tag_update', 'wiki_tag_delete', 'wiki_page_render', 'wiki_pages_purge_history']) {
    check(`A-12: ${name} is in category manage_system`, tool(name).category === 'manage_system');
  }
  const olderThan = (tool('wiki_pages_purge_history').inputSchema as unknown as Record<string, { safeParse(v: unknown): { success: boolean } }>).olderThan;
  for (const good of ['P1M', 'P30D', 'PT1H', 'P1Y2M', 'P2W', 'PT0.5S']) check(`A-12: olderThan "${good}" accepted`, olderThan.safeParse(good).success);
  for (const bad of ['1w', '30d', 'P', 'PT', 'P0D', 'PT0S', 'abc', '', 'P1DT']) check(`A-12: olderThan "${bad}" rejected`, !olderThan.safeParse(bad).success);
  check('A-12: purge description no longer suggests "1w"', !tool('wiki_pages_purge_history').description.includes('1w'));

  // ---- A-13: full-access API keys only with manage_auth = allow ----------------------
  const keyCreate = tool('wiki_apikey_create');
  s = stubCtx('maintainer');
  const fullKey = await settle(keyCreate.handler({ name: 'k', expiration: '30d', fullAccess: true, confirm: true }, s.ctx));
  check('A-13: maintainer (manage_auth confirm) creates a full-access key -> refused, nothing sent', fullKey.guardrail && s.calls.requests.length === 0);
  s = stubCtx('maintainer');
  const adminGroupKey = await settle(keyCreate.handler({ name: 'k', expiration: '30d', fullAccess: false, group: 1, confirm: true }, s.ctx));
  check('A-13: maintainer creates a key for the Administrators group -> refused', adminGroupKey.guardrail && s.calls.requests.length === 0);
  s = stubCtx('maintainer');
  check('A-13: maintainer creates a key for another group -> runs', !(await keyCreate.handler({ name: 'k', expiration: '30d', fullAccess: false, group: 3, confirm: true }, s.ctx)).isError && s.calls.requests.length === 1);
  s = stubCtx('systemadmin');
  check('A-13: systemadmin (manage_auth allow) creates a full-access key -> runs', !(await keyCreate.handler({ name: 'k', expiration: '30d', fullAccess: true }, s.ctx)).isError && s.calls.requests.length === 1);

  // ---- A-24: raw GraphQL results are redacted too -----------------------------------
  s = stubCtx('systemadmin', { fallback: { authentication: { login: { jwt: 'eyJ.secret.jwt', responseResult: { succeeded: true } } } } });
  const gqlOut = JSON.stringify(await tool('wiki_graphql').handler({ query: '{ site { config { title } } }' }, s.ctx));
  check('A-24: wiki_graphql result redacts secret-named fields', !gqlOut.includes('eyJ.secret.jwt') && gqlOut.includes('redacted'));

  // ---- A-31: navigation is manage:system in Wiki.js; links are checked ----------------
  const navGet = tool('wiki_navigation_get');
  check('A-31: wiki_navigation_get is manage_system + readOnly', navGet.category === 'manage_system' && navGet.readOnly === true);
  s = stubCtx('systemadmin');
  const jsLink = await settle(tool('wiki_navigation_update_tree').handler(
    { tree: [{ locale: 'en', items: [{ kind: 'link', label: 'x', targetType: 'external', target: 'java\tscript:alert(1)' }] }], force: true },
    s.ctx,
  ));
  check('A-31: a javascript: navigation target is refused before any request', jsLink.isError && s.calls.requests.length === 0);

  if (failed === 0) {
    console.log(`\n${pass} escalation assertions passed.`);
  } else {
    console.error(`\n${failed} escalation assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
