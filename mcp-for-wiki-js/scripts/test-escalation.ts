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

function stubCtx(role: string, opts: { mime?: string } = {}): { ctx: WikiContext; calls: Calls } {
  const calls: Calls = { requests: [], downloads: [] };
  const ctx = {
    client: {
      request: async (q: string) => {
        calls.requests.push(q);
        if (q.includes('users { create')) return { users: { create: { responseResult: { succeeded: true }, user: { id: 7 } } } };
        if (q.includes('users { update')) return { users: { update: { responseResult: { succeeded: true } } } };
        return { ok: true };
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
  const createAdmin = await create.handler({ ...userArgs, groups: [1], confirm: true }, s.ctx);
  check('R-12: moderator create with groups -> refused', createAdmin.isError === true && s.calls.requests.length === 0);
  s = stubCtx('moderator');
  check('R-12: moderator create without groups -> runs', !(await create.handler({ ...userArgs, groups: [], confirm: true }, s.ctx)).isError && s.calls.requests.length > 0);
  s = stubCtx('moderator');
  const updAdmin = await update.handler({ id: 2, groups: [1], confirm: true }, s.ctx);
  check('R-12: moderator update with groups -> refused', updAdmin.isError === true && s.calls.requests.length === 0);
  s = stubCtx('moderator');
  const strip = await update.handler({ id: 2, groups: [], confirm: true }, s.ctx);
  check('R-12: moderator update with groups: [] (strips memberships) -> refused', strip.isError === true && s.calls.requests.length === 0);
  s = stubCtx('moderator');
  check('R-12: moderator update without groups -> runs', !(await update.handler({ id: 2, name: 'x', confirm: true }, s.ctx)).isError && s.calls.requests.length > 0);

  // admin: manage_groups=confirm → groups need an explicit confirm
  s = stubCtx('admin');
  const preview = await update.handler({ id: 2, groups: [1] }, s.ctx);
  check('R-12: admin update with groups, no confirm -> preview, nothing sent', !preview.isError && s.calls.requests.length === 0);
  s = stubCtx('admin');
  check('R-12: admin update with groups + confirm -> runs', !(await update.handler({ id: 2, groups: [1], confirm: true }, s.ctx)).isError && s.calls.requests.length > 0);
  s = stubCtx('systemadmin');
  check('R-12: systemadmin create with groups -> runs', !(await create.handler({ ...userArgs, groups: [1] }, s.ctx)).isError && s.calls.requests.length > 0);

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
