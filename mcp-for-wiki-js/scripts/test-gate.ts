/**
 * In-process tests for the policy gate (lib/register.ts) over a real MCP
 * `tools/call` through the /mcp route (audit R-08): for every category, the
 * modes allow / confirm / block decide whether the upstream Wiki.js is called
 * at all, and executed or blocked calls land in the audit log.
 *
 * No network: the legacy single-tenant path (OAuth off, WIKIJS_TOKEN) talks to
 * a stubbed fetch. The policy per call is tightened with the X-Wikijs-Preset /
 * X-Wikijs-Policy headers on top of a systemadmin ceiling.
 *
 * Env is set BEFORE importing the route (the baseline policy is built at import
 * time), so the import is dynamic inside main().  Run: npm run test:gate
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

import type { Category } from '../lib/permissions';

process.env.WIKIJS_URL = 'https://wiki.example.org';
process.env.WIKIJS_TOKEN = 'service-key';
process.env.WIKIJS_PERMISSION_PRESET = 'systemadmin';
delete process.env.MCP_SESSION_SECRET;
delete process.env.WIKIJS_AUDIT;

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

// ---- upstream stub + audit capture ------------------------------------------
let upstreamCalls = 0;
const upstreamBodies: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://wiki.example.org')) {
    upstreamCalls++;
    const body = typeof init?.body === 'string' ? init.body : '';
    upstreamBodies.push(body);
    // Guardrail pre-fetch (blocked id set): page 7 carries the blocked tag.
    const data = body.includes('list(tags:$tags)')
      ? { pages: { list: [{ id: 7, path: 'intern/geheim' }] } }
      : body.includes('pages { tags { id tag } }')
        ? { pages: { tags: [{ id: 3, tag: 'kein-ki' }] } } // tag id 3 is the guardrail tag
        : body.includes('list(locale:$locale)')
          ? {
              pages: {
                list: [
                  { id: 11, path: 'drafts/a', locale: 'en', title: 'A' },
                  { id: 12, path: 'drafts/sub/b', locale: 'en', title: 'B' },
                ],
              },
            }
          : {};
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const auditLines: Array<{ tool: string; outcome: string }> = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === 'string' && first.includes('"audit":"wikijs-mcp"')) {
    auditLines.push(JSON.parse(first));
    return;
  }
  realLog(...args);
};

// ---- MCP plumbing -------------------------------------------------------------
function call(name: string, args: Record<string, unknown>, headers: Record<string, string>): Request {
  return new Request('http://mcp.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
}

async function rpcResult(res: Response): Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> {
  const text = await res.text();
  const json = text.trimStart().startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? '{}';
  return (JSON.parse(json) as { result?: Record<string, any> }).result ?? {};
}

/** One representative tool per category (simple args, no guardrail pre-fetch). The manage_*
 *  probes are state-changing tools: read-only manage_* tools are not audited (R-56, tested below). */
const PROBES: Record<Category, { tool: string; args: Record<string, unknown> }> = {
  read: { tool: 'wiki_site_info', args: {} },
  write: { tool: 'wiki_asset_create_folder', args: { slug: 'gate-test' } },
  delete: { tool: 'wiki_asset_delete', args: { id: 1 } },
  manage_users: { tool: 'wiki_user_activate', args: { id: 1 } },
  manage_groups: { tool: 'wiki_group_create', args: { name: 'gate-test' } },
  manage_system: { tool: 'wiki_pages_flush_cache', args: {} },
  manage_auth: { tool: 'wiki_apikey_revoke', args: { id: 1 } },
};

type Mode = 'allow' | 'confirm' | 'block';

/** Expected mode per category for each policy overlay (from config/roles.json). */
const SCENARIOS: Array<{ label: string; headers: Record<string, string>; modes: Record<Category, Mode> }> = [
  {
    label: 'no overlay (systemadmin ceiling)',
    headers: {},
    modes: { read: 'allow', write: 'allow', delete: 'allow', manage_users: 'allow', manage_groups: 'allow', manage_system: 'allow', manage_auth: 'allow' },
  },
  {
    label: 'preset wiki',
    headers: { 'x-wikijs-preset': 'wiki' },
    modes: { read: 'allow', write: 'allow', delete: 'confirm', manage_users: 'confirm', manage_groups: 'confirm', manage_system: 'confirm', manage_auth: 'confirm' },
  },
  {
    label: 'preset safe',
    headers: { 'x-wikijs-preset': 'safe' },
    modes: { read: 'allow', write: 'confirm', delete: 'confirm', manage_users: 'block', manage_groups: 'block', manage_system: 'block', manage_auth: 'block' },
  },
  {
    label: 'preset leser',
    headers: { 'x-wikijs-preset': 'leser' },
    modes: { read: 'allow', write: 'block', delete: 'block', manage_users: 'block', manage_groups: 'block', manage_system: 'block', manage_auth: 'block' },
  },
  {
    label: 'policy read=block',
    headers: { 'x-wikijs-policy': JSON.stringify({ categories: { read: 'block' } }) },
    modes: { read: 'block', write: 'allow', delete: 'allow', manage_users: 'allow', manage_groups: 'allow', manage_system: 'allow', manage_auth: 'allow' },
  },
];

async function main(): Promise<void> {
  const { POST } = await import('../app/[transport]/route');

  const run = async (tool: string, args: Record<string, unknown>, headers: Record<string, string>) => {
    const before = upstreamCalls;
    const auditBefore = auditLines.length;
    const result = await rpcResult(await POST(call(tool, args, headers)));
    return {
      result,
      text: (result.content ?? []).map((c) => c.text ?? '').join('\n'),
      upstream: upstreamCalls - before,
      audit: auditLines.slice(auditBefore),
    };
  };

  for (const sc of SCENARIOS) {
    for (const [category, probe] of Object.entries(PROBES) as Array<[Category, (typeof PROBES)[Category]]>) {
      const expected = sc.modes[category];
      const r = await run(probe.tool, probe.args, sc.headers);
      const label = `${sc.label}: ${category} (${probe.tool}) -> ${expected}`;
      if (expected === 'block') {
        check(label, r.result.isError === true && /blocked by the active permission policy/.test(r.text) && r.upstream === 0);
        if (category !== 'read') {
          check(`${label}: audited as "blocked"`, r.audit.some((a) => a.tool === probe.tool && a.outcome === 'blocked'));
        }
      } else if (expected === 'confirm') {
        check(label, /Confirmation required/.test(r.text) && r.upstream === 0 && r.audit.length === 0);
        const confirmed = await run(probe.tool, { ...probe.args, confirm: true }, sc.headers);
        check(`${label}: confirm=true executes`, confirmed.upstream > 0);
        check(`${label}: confirmed execution is audited`, confirmed.audit.some((a) => a.tool === probe.tool));
      } else {
        check(label, r.upstream > 0 && !/Confirmation required|blocked by the active/.test(r.text));
        if (category === 'read') check(`${label}: reads are not audited`, r.audit.length === 0);
      }
    }
  }

  // ---- tag guardrail refusals are policy decisions, not errors ----------------
  process.env.WIKIJS_BLOCKED_TAGS = 'kein-ki';
  upstreamBodies.length = 0;
  const g = await run('wiki_page_delete', { id: 7, confirm: true }, {});
  check('guardrail: delete of a kein-ki page is refused', g.result.isError === true && /not available to AI agents/.test(g.text));
  check('guardrail: the delete mutation never reaches Wiki.js', !upstreamBodies.some((b) => b.includes('delete(id:$id)')));
  check('guardrail: refusal is audited as "blocked" (not "error")', g.audit.some((a) => a.tool === 'wiki_page_delete' && a.outcome === 'blocked'));
  const t = await run('wiki_tag_delete', { id: 3, confirm: true }, {});
  check('guardrail: deleting the guardrail tag itself is refused', t.result.isError === true && /protected AI-guardrail tag/.test(t.text));
  check('guardrail: tag-delete refusal is audited as "blocked"', t.audit.some((a) => a.tool === 'wiki_tag_delete' && a.outcome === 'blocked'));
  delete process.env.WIKIJS_BLOCKED_TAGS;

  // ---- R-34: a read tool in "confirm" mode can be confirmed ---------------------
  const readConfirm = { 'x-wikijs-policy': JSON.stringify({ categories: { read: 'confirm' } }) };
  const rc = await run('wiki_site_info', {}, readConfirm);
  check('R-34: read=confirm -> preview first', /Confirmation required/.test(rc.text) && rc.upstream === 0);
  const rcOk = await run('wiki_site_info', { confirm: true }, readConfirm);
  check('R-34: read=confirm + confirm=true -> executes', rcOk.upstream > 0 && !/Confirmation required/.test(rcOk.text));

  // ---- R-56: read-only manage_* tools: same policy mode, but not audited --------
  const ro = await run('wiki_users_list', {}, {});
  check('R-56: users_list (allow) executes without an audit line', ro.upstream > 0 && ro.audit.length === 0);
  const roConfirm = await run('wiki_users_list', {}, { 'x-wikijs-preset': 'wiki' });
  check('R-56: users_list keeps manage_users=confirm (policy not loosened)', /Confirmation required/.test(roConfirm.text) && roConfirm.upstream === 0);
  const roConfirmed = await run('wiki_system_info', { confirm: true }, { 'x-wikijs-preset': 'wiki' });
  check('R-56: confirmed system_info executes without an audit line', roConfirmed.upstream > 0 && roConfirmed.audit.length === 0);
  const roBlocked = await run('wiki_groups_list', {}, { 'x-wikijs-preset': 'safe' });
  check('R-56: groups_list keeps manage_groups=block', roBlocked.result.isError === true && roBlocked.upstream === 0);

  // ---- R-19: secrets are redacted in confirm previews ---------------------------
  const pw = await run('wiki_user_create', { email: 'a@example.org', name: 'A', passwordRaw: 'Init-Secret-456' }, { 'x-wikijs-preset': 'wiki' });
  check('R-19: preview hides passwordRaw', /Confirmation required/.test(pw.text) && !pw.text.includes('Init-Secret-456') && /redacted/.test(pw.text));
  const npw = await run('wiki_user_update', { id: 2, newPassword: 'New-Secret-789' }, { 'x-wikijs-preset': 'wiki' });
  check('R-19: preview hides newPassword', /Confirmation required/.test(npw.text) && !npw.text.includes('New-Secret-789'));
  const blob = 'QUJD'.repeat(2000);
  const up = await run('wiki_asset_upload', { filename: 'a.bin', contentBase64: blob }, { 'x-wikijs-preset': 'safe' });
  check('R-19: preview shortens contentBase64', /Confirmation required/.test(up.text) && !up.text.includes(blob) && up.text.includes('8000'));

  // ---- R-06: confirm preview shows the pages a bulk delete would hit ------------
  upstreamBodies.length = 0;
  const pv = await run('wiki_pages_delete_batch', { pathPattern: 'drafts/*' }, { 'x-wikijs-preset': 'wiki' });
  check(
    'R-06: batch-delete preview lists the resolved targets',
    /Confirmation required/.test(pv.text) && pv.text.includes('en/drafts/a') && !pv.text.includes('drafts/sub/b') && /"count": 1/.test(pv.text),
  );
  check('R-06: the preview deletes nothing', !upstreamBodies.some((b) => b.includes('delete(id:$id)')) && pv.audit.length === 0);

  // ---- Review 2026-10-21 #2: parameter gates audit like the tool gate ----------
  const groupsBlocked = { 'x-wikijs-policy': JSON.stringify({ categories: { manage_groups: 'block' } }) };
  const gb = await run('wiki_user_update', { id: 2, groups: [1] }, groupsBlocked);
  check('#2: blocked "groups" parameter -> refused, nothing sent', gb.result.isError === true && /blocked by the active permission policy/.test(gb.text) && gb.upstream === 0);
  check('#2: blocked parameter is audited as "blocked" (not "error")', gb.audit.length === 1 && gb.audit[0].outcome === 'blocked');
  const groupsConfirm = { 'x-wikijs-policy': JSON.stringify({ categories: { manage_groups: 'confirm' } }) };
  const gc = await run('wiki_user_update', { id: 2, groups: [1] }, groupsConfirm);
  check('#2: confirm-gated parameter -> dry run, nothing sent', /DRY RUN/.test(gc.text) && gc.upstream === 0);
  check('#2: parameter dry run is not audited as an execution', gc.audit.length === 0);
  const gcOk = await run('wiki_user_update', { id: 2, groups: [1], confirm: true }, groupsConfirm);
  check('#2: confirmed parameter executes and is audited', gcOk.upstream > 0 && gcOk.audit.length === 1 && gcOk.audit[0].outcome !== 'blocked');
  const gqlDry = await run('wiki_graphql', { query: 'mutation { pages { delete(id: 1) { responseResult { succeeded } } } }' }, {});
  check('#2: wiki_graphql mutation dry run -> nothing sent, not audited', /DRY RUN/.test(gqlDry.text) && gqlDry.upstream === 0 && gqlDry.audit.length === 0);

  // ---- Review 2026-10-21 #6: nested secrets are redacted in previews ------------
  const nested = {
    query: 'mutation($i: UserInput) { users { create(input: $i) { responseResult { succeeded } } } }',
    variables: { passwordRaw: 'Top-Secret-111', input: { email: 'x@example.org', passwordRaw: 'Nested-Secret-222' }, list: [{ newPassword: 'Array-Secret-333' }] },
  };
  const secrets = ['Top-Secret-111', 'Nested-Secret-222', 'Array-Secret-333'];
  const np = await run('wiki_graphql', nested, { 'x-wikijs-policy': JSON.stringify({ categories: { manage_system: 'confirm' } }) });
  check('#6: confirm preview redacts nested secrets', /Confirmation required/.test(np.text) && secrets.every((x) => !np.text.includes(x)) && np.text.includes('x@example.org'));
  const nd = await run('wiki_graphql', nested, {});
  check('#6: wiki_graphql own dry run redacts secrets in variables', /DRY RUN/.test(nd.text) && secrets.every((x) => !nd.text.includes(x)) && nd.text.includes('x@example.org'));

  // ---- R-38 / R-56 / R-34: advertised tool metadata -----------------------------
  const listRes = await POST(
    new Request('http://mcp.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }),
  );
  const listed = ((await rpcResult(listRes)) as { tools?: Array<{ name: string; annotations?: Record<string, unknown>; inputSchema?: { properties?: Record<string, unknown> } }> }).tools ?? [];
  const meta = (name: string) => listed.find((t) => t.name === name);
  for (const name of ['wiki_user_delete', 'wiki_group_delete', 'wiki_user_disable_tfa', 'wiki_page_restore', 'wiki_navigation_update_tree']) {
    check(`R-38: ${name} carries destructiveHint`, meta(name)?.annotations?.destructiveHint === true);
  }
  for (const name of ['wiki_users_list', 'wiki_system_info', 'wiki_apikeys_list', 'wiki_group_get']) {
    const a = meta(name)?.annotations ?? {};
    check(`R-56: ${name} is readOnlyHint, not destructive`, a.readOnlyHint === true && a.destructiveHint !== true);
  }
  check('R-56: wiki_graphql (can mutate) is not marked read-only', meta('wiki_graphql')?.annotations?.readOnlyHint !== true);
  check('R-34: read tools advertise the confirm field', !!meta('wiki_site_info')?.inputSchema?.properties?.confirm);

  // ---- R-20: server instructions mark wiki content as data ----------------------
  const { INSTRUCTIONS } = await import('../lib/meta');
  check('R-20: INSTRUCTIONS say wiki content is data, not instructions', /untrusted/i.test(INSTRUCTIONS) && /not (as )?instructions/i.test(INSTRUCTIONS));

  // ---- A-52: audit lines name their targets; blocked reads are logged ----------------
  const del = await run('wiki_asset_delete', { id: 41 }, {});
  check('A-52: the audit line names the target id', del.audit.some((a) => a.tool === 'wiki_asset_delete' && JSON.stringify((a as { targets?: unknown }).targets ?? null).includes('41')));
  const blockedRead = await run('wiki_site_info', {}, { 'x-wikijs-policy': JSON.stringify({ categories: { read: 'block' } }) });
  check('A-52: a read blocked by policy is audited as "blocked"', blockedRead.audit.some((a) => a.tool === 'wiki_site_info' && a.outcome === 'blocked'));
  const allowedRead = await run('wiki_site_info', {}, {});
  check('A-52: allowed reads stay out of the audit log', allowedRead.audit.length === 0);
  const secretArgs = await run('wiki_user_reset_password', { id: 5, newPassword: 'Never-Logged-123' }, {});
  check('A-52: targets never carry secret arguments', !JSON.stringify(secretArgs.audit).includes('Never-Logged-123'));

  globalThis.fetch = realFetch;
  console.log = realLog;
  if (failed === 0) {
    console.log(`\n${pass} gate assertions passed.`);
  } else {
    console.error(`\n${failed} gate assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
