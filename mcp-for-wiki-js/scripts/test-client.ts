/**
 * Offline tests for lib/wikijs/client.ts against a stubbed global fetch (audit R-54):
 *  - R-36 env parsing (WIKIJS_RETRIES=0 really disables retries)
 *  - R-32 retry only when nothing was sent (mutations) / broader for queries
 *  - R-45 timeout covers reading the body; response size is capped
 *  - R-47 the concurrency slot is released during backoff
 *  - R-27 no redirects are followed (GraphQL + upload)
 *  - error mapping: non-JSON, GraphQL errors on HTTP 200, HTTP status, no data
 *  - new-jwt renewal, upload result parsing
 * Env is set BEFORE the client module is imported (its limits are read at load).
 * Run: npm run test:client
 */
export {}; // module scope — keeps `pass`/`failed` from colliding with the other test scripts

import http from 'node:http';

process.env.WIKIJS_RETRIES = '0';
process.env.WIKIJS_MAX_CONCURRENCY = '1';
process.env.WIKIJS_MAX_RESPONSE_BYTES = '4096';
// Above setTimeout's 2^31-1 ms limit, which Node turns into a 1 ms timer (review #9).
process.env.WIKIJS_TIMEOUT_MS = '99999999999';

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

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;
let handler: Handler = () => json({ data: {} });
const seen: Array<{ url: string; init: RequestInit }> = [];
const realFetch = globalThis.fetch;
const stubFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  seen.push({ url, init });
  return handler(url, init);
}) as typeof fetch;
globalThis.fetch = stubFetch;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** What Node's fetch throws for a network failure: TypeError('fetch failed') with a coded cause. */
function netError(code: string): TypeError {
  const cause = Object.assign(new Error(code), { code });
  return new TypeError('fetch failed', { cause });
}

async function rejection(p: Promise<unknown>, guardMs = 3000): Promise<string> {
  const guard = new Promise<string>((r) => setTimeout(() => r('GUARD-TIMEOUT'), guardMs));
  return Promise.race([p.then(() => 'RESOLVED', (e) => (e instanceof Error ? e.message : String(e))), guard]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const URL_ = 'https://wiki.example.org';
const MUTATION = 'mutation{ pages { delete(id:1){ responseResult { succeeded } } } }';
const QUERY = 'query{ pages { list { id } } }';

async function main(): Promise<void> {
  const { WikiClient, WikiConnectionError, envInt } = await import('../lib/wikijs/client');

  // ---- R-36: env parsing ------------------------------------------------------
  check('R-36: envInt keeps 0 when 0 is allowed', envInt('0', 2, 0) === 0);
  check('R-36: envInt falls back on empty', envInt(undefined, 30_000, 1) === 30_000 && envInt('', 30_000, 1) === 30_000);
  check('R-36: envInt falls back on garbage', envInt('abc', 8, 1) === 8);
  check('R-36: envInt rejects values below the minimum (no negative timeout)', envInt('-1', 30_000, 1) === 30_000);
  check('R-36: envInt parses a normal value', envInt('250', 30_000, 1) === 250);
  check('#9: envInt falls back above the maximum', envInt('2147483648', 30_000, 1, 600_000) === 30_000);
  check('#9: envInt accepts the maximum itself', envInt('600000', 30_000, 1, 600_000) === 600_000);
  handler = async (_u, init) => {
    await sleep(30);
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError'); // like undici
    return json({ data: { slow: true } });
  };
  const defTimeout = await rejection(new WikiClient(URL_, 't').request(QUERY));
  check(`#9: an oversized WIKIJS_TIMEOUT_MS does not make every request time out (${defTimeout})`, defTimeout === 'RESOLVED');

  let attempts = 0;
  handler = () => {
    attempts++;
    throw netError('ECONNREFUSED');
  };
  const noRetry = new WikiClient(URL_, 't', 2000);
  const r36 = await rejection(noRetry.request(QUERY));
  check('R-36: WIKIJS_RETRIES=0 -> exactly one attempt', attempts === 1 && /Could not reach Wiki\.js/.test(r36));

  // ---- R-32: retry semantics ------------------------------------------------
  const retrying = new WikiClient(URL_, 't', 2000, { retries: 2 });
  const failThen = (code: string, failures: number): Handler => () => {
    attempts++;
    if (attempts <= failures) throw netError(code);
    return json({ data: { ok: true } });
  };

  attempts = 0;
  handler = failThen('ECONNRESET', 1);
  await rejection(retrying.request(MUTATION));
  check('R-32: mutation + ECONNRESET (request may have been sent) -> NOT retried', attempts === 1);

  attempts = 0;
  handler = failThen('UND_ERR_SOCKET', 1);
  await rejection(retrying.request(MUTATION));
  check('R-32: mutation + UND_ERR_SOCKET -> NOT retried', attempts === 1);

  attempts = 0;
  handler = failThen('ECONNREFUSED', 1);
  const refusedThenOk = await rejection(retrying.request(MUTATION));
  check('R-32: mutation + ECONNREFUSED (nothing sent) -> retried and succeeds', attempts === 2 && refusedThenOk === 'RESOLVED');

  attempts = 0;
  handler = failThen('ENOTFOUND', 1);
  check('R-32: mutation + ENOTFOUND -> retried', (await rejection(retrying.request(MUTATION))) === 'RESOLVED' && attempts === 2);

  attempts = 0;
  handler = failThen('ECONNRESET', 1);
  check('R-32: query + ECONNRESET -> retried (reads are idempotent)', (await rejection(retrying.request(QUERY))) === 'RESOLVED' && attempts === 2);

  attempts = 0;
  handler = failThen('ECONNREFUSED', 5);
  await rejection(retrying.request(QUERY));
  check('R-32: retries are bounded (1 + retries attempts)', attempts === 3);

  // ---- R-45: timeout covers the body; size cap ------------------------------
  handler = (_u, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"data":'));
        // Like undici: an abort errors the body stream mid-read.
        init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const slowBody = await rejection(new WikiClient(URL_, 't', 200).request(QUERY), 2000);
  check('R-45: a body that never finishes hits the timeout', /timed out/.test(slowBody));

  handler = () => json({ data: { blob: 'x'.repeat(10_000) } });
  const big = await rejection(new WikiClient(URL_, 't', 2000).request(QUERY));
  check('R-45: response over WIKIJS_MAX_RESPONSE_BYTES is refused', /too large|exceeds/i.test(big));

  handler = () => new Response('{"data":{}}', { status: 200, headers: { 'content-length': '999999' } });
  const bigHeader = await rejection(new WikiClient(URL_, 't', 2000).request(QUERY));
  check('R-45: oversized Content-Length is refused before reading', /too large|exceeds/i.test(bigHeader));

  handler = () => json({ data: { small: true } });
  check('R-45: a normal response still parses', (await new WikiClient(URL_, 't', 2000).request<{ small: boolean }>(QUERY)).small === true);

  // ---- R-47: slot released during backoff -----------------------------------
  // Concurrency is 1. A fails once (refused) and retries; B is queued meanwhile.
  // B must run during A's backoff instead of waiting for A's whole retry chain.
  const order: string[] = [];
  let aCalls = 0;
  handler = async (_u, init) => {
    const body = String(init.body);
    if (body.includes('AAA')) {
      aCalls++;
      order.push(`A${aCalls}`);
      if (aCalls === 1) throw netError('ECONNREFUSED');
      return json({ data: { a: true } });
    }
    order.push('B');
    await sleep(5);
    return json({ data: { b: true } });
  };
  const gated = new WikiClient(URL_, 't', 3000, { retries: 1 });
  const pA = gated.request('query AAA { x }');
  const pB = gated.request('query BBB { x }');
  await Promise.allSettled([pA, pB]);
  check(`R-47: queued request runs during the other's backoff (order ${order.join(',')})`, order.join(',') === 'A1,B,A2');

  // ---- R-27: no redirects ---------------------------------------------------
  seen.length = 0;
  handler = () => json({ data: {} });
  await new WikiClient(URL_, 't', 2000).request(QUERY);
  check("R-27: GraphQL POST uses redirect: 'error'", seen[0]?.init.redirect === 'error');
  seen.length = 0;
  handler = () => new Response('ok', { status: 200 });
  await new WikiClient(URL_, 't', 2000).upload({ filename: 'a.png', data: new Uint8Array([1]) });
  check("R-27: upload uses redirect: 'error'", seen[0]?.init.redirect === 'error');

  // ---- Review 2026-10-21 #5: redirects and connection-error detail ----------------
  const redirectError = () => new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  attempts = 0;
  handler = () => {
    attempts++;
    throw redirectError();
  };
  const redir = await rejection(new WikiClient(URL_, 't', 2000, { retries: 2 }).request(QUERY));
  check(`#5: redirect -> clear message, not "fetch failed" (${redir})`, /redirect/i.test(redir) && /WIKIJS_URL/.test(redir) && !/Could not reach/.test(redir));
  check('#5: a redirect is not retried (even for a query)', attempts === 1);
  const redirErr = await new WikiClient(URL_, 't', 2000).request(QUERY).catch((e: unknown) => e);
  check('#5: a redirect still counts as an upstream availability problem (WikiConnectionError)', redirErr instanceof WikiConnectionError);
  const upRedir = await rejection(new WikiClient(URL_, 't', 2000).upload({ filename: 'a.png', data: new Uint8Array([1]) }));
  check('#5: upload redirect -> same clear message', /redirect/i.test(upRedir) && /WIKIJS_URL/.test(upRedir));
  const dlRedir = await rejection(new WikiClient(URL_, 't', 2000).download('uploads/a.png'));
  check('#5: download redirect -> same clear message', /redirect/i.test(dlRedir) && /WIKIJS_URL/.test(dlRedir));
  handler = () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:3000'), { code: 'ECONNREFUSED' }) });
  };
  const refusedMsg = await rejection(new WikiClient(URL_, 't', 2000).request(QUERY));
  check(`#5: connection error carries the cause (${refusedMsg})`, refusedMsg.includes('connect ECONNREFUSED 10.0.0.9:3000'));
  const upRefused = await rejection(new WikiClient(URL_, 't', 2000).upload({ filename: 'a.png', data: new Uint8Array([1]) }));
  check('#5: upload connection error carries the cause', upRefused.includes('connect ECONNREFUSED 10.0.0.9:3000'));

  // Same against Node's REAL fetch (undici) and a local server answering 302.
  let hits = 0;
  const srv = http.createServer((_req, res) => {
    hits++;
    res.writeHead(302, { location: '/login' });
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const local = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  globalThis.fetch = realFetch;
  try {
    const real = await rejection(new WikiClient(local, 't', 2000, { retries: 2 }).request(QUERY));
    check(`#5: real fetch: 302 -> redirect message, one attempt (${hits} hit(s): ${real})`, /redirect/i.test(real) && hits === 1);
  } finally {
    globalThis.fetch = stubFetch;
    srv.close();
  }

  // ---- R-54: error mapping --------------------------------------------------
  const c = new WikiClient(URL_, 'secret-token', 2000);
  handler = () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
  check('R-54: non-JSON response -> clear error with status', /non-JSON response \(HTTP 502\)/.test(await rejection(c.request(QUERY))));
  handler = () => json({ errors: [{ message: 'Forbidden' }, { message: 'Second' }], data: null });
  check('R-54: GraphQL errors on HTTP 200 are thrown', (await rejection(c.request(QUERY))) === 'Forbidden; Second');
  handler = () => json({ data: { x: 1 } }, 500);
  check('R-54: HTTP 500 without GraphQL errors -> status error', /HTTP 500/.test(await rejection(c.request(QUERY))));
  handler = () => json({ data: null });
  check('R-54: null data -> error', /no data/.test(await rejection(c.request(QUERY))));
  seen.length = 0;
  handler = () => json({ data: { ok: 1 } });
  await c.request(QUERY, { a: 1 });
  const sent = seen[0];
  check('R-54: bearer token is sent', (sent?.init.headers as Record<string, string>)?.authorization === 'Bearer secret-token');
  check('R-54: endpoint is <base>/graphql', sent?.url === `${URL_}/graphql`);
  check('R-54: query + variables in the JSON body', JSON.parse(String(sent?.init.body)).variables.a === 1);

  // ---- R-54: new-jwt renewal -------------------------------------------------
  let renewed = '';
  const jwtClient = new WikiClient(URL_, 'old', 2000, { onNewJwt: (j) => (renewed = j) });
  handler = () => json({ data: { ok: 1 } }, 200, { 'new-jwt': 'fresh.jwt.value' });
  await jwtClient.request(QUERY);
  check('R-54: new-jwt header is forwarded to onNewJwt', renewed === 'fresh.jwt.value');
  const throwingJwt = new WikiClient(URL_, 'old', 2000, {
    onNewJwt: () => {
      throw new Error('store down');
    },
  });
  check('R-54: a failing onNewJwt never breaks the request', (await rejection(throwingJwt.request(QUERY))) === 'RESOLVED');

  // ---- R-54: upload -----------------------------------------------------------
  seen.length = 0;
  handler = () => new Response('ok', { status: 200 });
  const up = await c.upload({ filename: 'a.png', data: new Uint8Array([1, 2, 3]), mime: 'image/png', folderId: 4 });
  const form = seen[0]?.init.body as FormData;
  const parts = form.getAll('mediaUpload');
  check('R-54: upload "ok" -> succeeded', up.succeeded === true);
  check('R-54: upload posts to <base>/u', seen[0]?.url === `${URL_}/u`);
  check('R-54: upload sends folder metadata then the file under the same field', parts.length === 2 && JSON.parse(String(parts[0])).folderId === 4 && parts[1] instanceof Blob);
  handler = () => json({ succeeded: false, message: 'Forbidden folder' });
  const upFail = await c.upload({ filename: 'a.png', data: new Uint8Array([1]) });
  check('R-54: upload JSON failure -> message surfaced', upFail.succeeded === false && upFail.message === 'Forbidden folder');
  handler = () => new Response('Payload Too Large', { status: 413 });
  const up413 = await c.upload({ filename: 'a.png', data: new Uint8Array([1]) });
  check('R-54: upload HTTP 413 -> not succeeded, status in message', up413.succeeded === false && /HTTP 413/.test(up413.message ?? ''));

  globalThis.fetch = realFetch;
  if (failed === 0) {
    console.log(`\n${pass} client assertions passed.`);
  } else {
    console.log(`\n${failed} FAILED (of ${pass + failed}).`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
