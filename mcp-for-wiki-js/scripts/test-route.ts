/**
 * Offline tests for the /mcp route handler (app/[transport]/route.ts) on top of
 * mcp-handler 2.x: path restriction, the OAuth 401 discovery challenge, the
 * legacy initialize round-trip, and the tool JSON schemas clients see.
 * No network — the route's exported POST handler is called with Request objects.
 *
 * Env is set BEFORE importing the route (the baseline policy is built at import
 * time), so the import is dynamic inside main().  Run: npm run test:route
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

process.env.WIKIJS_URL = 'https://wiki.example.org';
process.env.WIKIJS_PERMISSION_PRESET = 'systemadmin'; // every tool visible in tools/list
delete process.env.MCP_SESSION_SECRET;
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

function rpc(method: string, params: Record<string, unknown> = {}, path = '/mcp'): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** The legacy transport may answer as JSON or as a single SSE `data:` event. */
async function rpcResult(res: Response): Promise<Record<string, any>> {
  const text = await res.text();
  const json = text.trimStart().startsWith('{')
    ? text
    : text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? '{}';
  return (JSON.parse(json) as { result?: Record<string, any> }).result ?? {};
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-route', version: '1' } };

async function main(): Promise<void> {
  const { POST } = await import('../app/[transport]/route');

  // 1. mcp-handler 2.x no longer routes by pathname — the route must.
  check('POST /foo → 404 (catch-all serves only /mcp)', (await POST(rpc('initialize', INIT, '/foo'))).status === 404);
  check('POST /sse → 404 (no SSE transport)', (await POST(rpc('initialize', INIT, '/sse'))).status === 404);

  // 2. OAuth on: credential-less request → spec 401 + resource-metadata challenge.
  process.env.MCP_SESSION_SECRET = 'x'.repeat(32);
  const denied = await POST(rpc('initialize', INIT));
  const challenge = denied.headers.get('www-authenticate') ?? '';
  check('oauth on, no token → 401', denied.status === 401);
  check('oauth on, no token → Bearer challenge', challenge.startsWith('Bearer '));
  check(
    'oauth on, no token → resource_metadata points at the RFC 9728 document',
    challenge.includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`),
  );
  delete process.env.MCP_SESSION_SECRET;

  // 3. OAuth off: legacy stateless transport answers initialize.
  const init = await POST(rpc('initialize', INIT));
  const initResult = await rpcResult(init);
  check('oauth off, initialize → 200', init.status === 200);
  check('oauth off, initialize → serverInfo returned', typeof initResult.serverInfo?.name === 'string');

  // 4. Tool schemas as clients see them (zod → JSON Schema via the SDK).
  const list = await rpcResult(await POST(rpc('tools/list')));
  const tools = (list.tools ?? []) as Array<{ name: string; inputSchema: { required?: string[]; properties?: Record<string, unknown> } }>;
  const tool = (name: string) => tools.find((t) => t.name === name)?.inputSchema;
  const get = tool('wiki_page_get');
  const create = tool('wiki_page_create');
  check('tools/list returns tools', tools.length > 0);
  check('defaulted field stays optional (wiki_page_get.locale)', !!get?.properties?.locale && !(get.required ?? []).includes('locale'));
  check('required field stays required (wiki_page_create.path)', (create?.required ?? []).includes('path'));
  check('confirm is added to non-read tools (wiki_page_create)', !!create?.properties?.confirm);
  check('confirm is NOT added to read tools (wiki_page_get)', !get?.properties?.confirm);

  if (failed === 0) {
    console.log(`\n${pass} route assertions passed.`);
  } else {
    console.error(`\n${failed} route assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
