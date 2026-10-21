/**
 * Offline tests for request-body limits (audit R-09) and DCR limits (R-10):
 * the capped reader, 413 on every body-reading route BEFORE auth/OAuth logic,
 * and the redirect-URI length cap. No network; the OAuth store is in-memory.
 *
 * Env is set BEFORE importing the routes (baseline policy / issuer read env),
 * so the imports are dynamic inside main().  Run: npm run test:limits
 */
export {}; // module scope — keep pass/failed from colliding with sibling test scripts

process.env.MCP_SESSION_SECRET = 'test-secret-for-limits-suite-0123456789';
process.env.PUBLIC_BASE_URL = 'http://mcp.test';
process.env.WIKIJS_URL = 'http://wiki.test';
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
const KB = 1024;

/** A body streamed in chunks WITHOUT Content-Length (chunked upload). */
function streamed(bytes: number, chunk = 16 * KB): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (sent >= bytes) return ctrl.close();
      const n = Math.min(chunk, bytes - sent);
      sent += n;
      ctrl.enqueue(new Uint8Array(n).fill(97));
    },
  });
}

function post(path: string, body: BodyInit | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
    // Node's fetch Request needs duplex for stream bodies.
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
}

async function main(): Promise<void> {
  const { readBody, FORM_BODY_LIMIT, MCP_BODY_LIMIT } = await import('../lib/body-limit');
  const store = await import('../lib/oauth/store');
  const service = await import('../lib/oauth/service');
  store.openTestStore();

  // 1. The capped reader.
  check('readBody: small body → text', (await readBody(post('/x', 'a=1'), 64)) === 'a=1');
  check('readBody: exactly at the limit → text', (await readBody(post('/x', 'a'.repeat(64)), 64)) === 'a'.repeat(64));
  const declared = await readBody(post('/x', 'a', { 'content-length': String(10 * 1024 * 1024) }), 64);
  check('readBody: declared Content-Length over the limit → 413 without reading', declared instanceof Response && declared.status === 413);
  const chunked = await readBody(post('/x', streamed(200 * KB)), 64 * KB);
  check('readBody: chunked body over the limit → 413', chunked instanceof Response && chunked.status === 413);
  check('readBody: multi-byte text is decoded across chunks', (await readBody(post('/x', 'ä€🔑'), 64)) === 'ä€🔑');
  check('limits: forms 64 KB, /mcp 4 MB', FORM_BODY_LIMIT === 64 * KB && MCP_BODY_LIMIT === 4 * KB * KB);

  // 2. Every body-reading route answers 413 for an oversized (chunked) body.
  const big = () => streamed(FORM_BODY_LIMIT + 1);
  const routes: Array<[string, string, () => Promise<{ POST: (r: Request) => Promise<Response> }>]> = [
    ['/oauth/token', '/oauth/token', () => import('../app/oauth/token/route')],
    ['/oauth/register', '/oauth/register', () => import('../app/oauth/register/route')],
    ['/oauth/authorize/decision', '/oauth/authorize/decision', () => import('../app/oauth/authorize/decision/route')],
    ['/me/login', '/me/login', () => import('../app/me/login/route')],
  ];
  for (const [label, path, load] of routes) {
    const { POST } = await load();
    check(`${label}: oversized body → 413`, (await POST(post(path, big()))).status === 413);
  }

  // 3. /mcp: the query-param path re-reads the body itself → must be capped too.
  const { POST: mcpPost } = await import('../app/[transport]/route');
  const mcpRes = await mcpPost(
    post('/mcp?token=handle', streamed(MCP_BODY_LIMIT + 1, 256 * KB), { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
  );
  check('/mcp?token=…: oversized body → 413 (before routing/auth)', mcpRes.status === 413);

  // 4. DCR (R-10): redirect URIs are length-capped.
  const long = 'https://client.example/cb?x=' + 'a'.repeat(2100);
  let rejected = false;
  try {
    service.registerClient({ redirect_uris: [long] });
  } catch (e) {
    rejected = (e as { code?: string }).code === 'invalid_redirect_uri';
  }
  check('DCR: redirect_uri longer than 2048 chars → invalid_redirect_uri', rejected);
  check('DCR: normal redirect_uri still registers', service.registerClient({ redirect_uris: ['https://client.example/cb'] }).client_id.startsWith('mcp_client_'));

  if (failed === 0) {
    console.log(`\n${pass} limit assertions passed.`);
  } else {
    console.error(`\n${failed} limit assertion(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
