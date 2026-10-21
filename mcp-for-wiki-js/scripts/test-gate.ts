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
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://wiki.example.org')) {
    upstreamCalls++;
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
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

/** One representative tool per category (simple args, no guardrail pre-fetch). */
const PROBES: Record<Category, { tool: string; args: Record<string, unknown> }> = {
  read: { tool: 'wiki_site_info', args: {} },
  write: { tool: 'wiki_asset_create_folder', args: { slug: 'gate-test' } },
  delete: { tool: 'wiki_asset_delete', args: { id: 1 } },
  manage_users: { tool: 'wiki_users_list', args: {} },
  manage_groups: { tool: 'wiki_groups_list', args: {} },
  manage_system: { tool: 'wiki_system_info', args: {} },
  manage_auth: { tool: 'wiki_apikeys_list', args: {} },
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
