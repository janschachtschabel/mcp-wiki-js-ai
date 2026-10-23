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
process.env.WIKIJS_MAX_CONCURRENCY_TOTAL = '2';
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
  const { WikiClient, WikiConnectionError, AssetTooLargeError, envInt } = await import('../lib/wikijs/client');

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

  // ---- Audit 2026-10-23 package S5 --------------------------------------------
  // A-34: a renewed JWT replaces the old one for the rest of the call.
  seen.length = 0;
  let renewals = 0;
  handler = () => (++renewals === 1 ? json({ data: { a: 1 } }, 200, { 'new-jwt': 'renewed-jwt' }) : json({ data: { b: 1 } }));
  const renewing = new WikiClient(URL_, 'old-jwt', 2000, { onNewJwt: () => {} });
  await renewing.request(QUERY);
  await renewing.request(QUERY);
  const authOf = (i: number) => (seen[i]?.init.headers as Record<string, string> | undefined)?.authorization;
  check('A-34: the request after a renewal sends the renewed JWT', authOf(0) === 'Bearer old-jwt' && authOf(1) === 'Bearer renewed-jwt');

  // A-45: downloads without Content-Length are capped while streaming; upload answers too.
  const streamOf = (chunks: number) =>
    new ReadableStream<Uint8Array>({
      start(ctl) {
        for (let i = 0; i < chunks; i++) ctl.enqueue(new Uint8Array(1000));
        ctl.close();
      },
    });
  handler = () => new Response(streamOf(6), { status: 200, headers: { 'content-type': 'image/png' } });
  const dlBig = await new WikiClient(URL_, 't', 2000).download('uploads/a.png', 4000).catch((e: unknown) => e);
  check('A-45: a download without Content-Length is refused once it passes the cap', dlBig instanceof AssetTooLargeError);
  handler = () => new Response(streamOf(3), { status: 200, headers: { 'content-type': 'image/png' } });
  const dlOk = await new WikiClient(URL_, 't', 2000).download('uploads/a.png', 4000);
  check('A-45: a small download without Content-Length still arrives whole', dlOk.data.byteLength === 3000 && dlOk.mime === 'image/png');
  handler = () =>
    new Response(new ReadableStream<Uint8Array>({ pull: (ctl) => ctl.enqueue(new Uint8Array(1024)) }), { status: 500 });
  const endless = await rejection(new WikiClient(URL_, 't', 2000).upload({ filename: 'a.png', data: new Uint8Array([1]) }), 3000);
  check(`A-45: an endless upload answer is not buffered (${endless})`, endless !== 'GUARD-TIMEOUT');

  // A-47: proxy 5xx on reads is retried; retries stop at the overall deadline.
  attempts = 0;
  handler = () => (++attempts === 1 ? new Response('Service Unavailable', { status: 503 }) : json({ data: { ok: true } }));
  check('A-47: a proxy 503 on a read is retried', (await rejection(new WikiClient(URL_, 't', 2000, { retries: 2 }).request(QUERY))) === 'RESOLVED' && attempts === 2);
  attempts = 0;
  const mut503 = await rejection(new WikiClient(URL_, 't', 2000, { retries: 2 }).request(MUTATION));
  check('A-47: … but not on a mutation (it may have reached Wiki.js)', attempts === 1 && /HTTP 503/.test(mut503));
  attempts = 0;
  handler = async () => {
    attempts++;
    await sleep(120);
    throw netError('ECONNREFUSED');
  };
  await rejection(new WikiClient(URL_, 't', 200, { retries: 5 }).request(QUERY), 5000);
  check(`A-47: retries stop at the overall deadline (${attempts} attempts)`, attempts <= 2);

  // A-15: a cancelled MCP request aborts the upstream call and sends nothing more.
  const ac = new AbortController();
  handler = async (_u, init) => {
    await sleep(50);
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return json({ data: {} });
  };
  const cancellable = new WikiClient(URL_, 't', 5000, { signal: ac.signal, retries: 2 });
  const inFlight = rejection(cancellable.request(QUERY));
  setTimeout(() => ac.abort(), 10);
  check('A-15: cancelling aborts the in-flight upstream request', /cancel/i.test(await inFlight));
  seen.length = 0;
  const afterCancel = await rejection(cancellable.request(QUERY));
  check('A-15: nothing is sent once the request is cancelled', /cancel/i.test(afterCancel) && seen.length === 0);

  // A-20: one concurrency gate per wiki (WIKIJS_MAX_CONCURRENCY=1 here).
  let releaseA: () => void = () => {};
  handler = (url) =>
    url.startsWith('https://a.example')
      ? new Promise<Response>((r) => {
          releaseA = () => r(json({ data: { a: 1 } }));
        })
      : json({ data: { b: 1 } });
  const slowA = new WikiClient('https://a.example', 't', 2000).request(QUERY);
  const otherWiki = await rejection(new WikiClient('https://b.example', 't', 2000).request(QUERY), 500);
  releaseA();
  await slowA;
  check('A-20: a busy wiki does not block requests to another wiki', otherWiki === 'RESOLVED');

  // A-46: the target check (DNS) is bounded and runs before a slot is taken.
  handler = () => json({ data: { ok: 1 } });
  const hang = await rejection(new WikiClient('https://c.example', 't', 200, { assertTarget: () => new Promise(() => {}) }).request(QUERY), 2000);
  check(`A-46: a hanging target check times out (${hang})`, /timed out/i.test(hang));
  const hanging = rejection(new WikiClient('https://d.example', 't', 1000, { assertTarget: () => new Promise(() => {}) }).request(QUERY), 3000);
  const sameHost = await rejection(new WikiClient('https://d.example', 't', 1000).request(QUERY), 500);
  check('A-46: a hanging target check does not hold the concurrency slot', sameHost === 'RESOLVED');
  await hanging;

  // ---- Review 2026-10-23 (S6) -----------------------------------------------------
  // A global ceiling over all wikis (WIKIJS_MAX_CONCURRENCY_TOTAL=2 here).
  const releases: Array<() => void> = [];
  handler = (url) =>
    url.startsWith('https://slow')
      ? new Promise<Response>((r) => releases.push(() => r(json({ data: { ok: 1 } }))))
      : json({ data: { ok: 2 } });
  const s1 = new WikiClient('https://slow1.example', 't', 2000).request(QUERY);
  const s2 = new WikiClient('https://slow2.example', 't', 2000).request(QUERY);
  await sleep(20);
  const third = await rejection(new WikiClient('https://fast.example', 't', 2000).request(QUERY), 300);
  check(`S6: a global ceiling caps requests across all wikis (${third})`, third === 'GUARD-TIMEOUT');
  releases.forEach((r) => r());
  await Promise.allSettled([s1, s2]);
  await sleep(50);

  // The per-wiki gate key is canonical: case and default port do not open a second gate.
  releases.length = 0;
  const slowA2 = new WikiClient('https://slow3.example', 't', 2000).request(QUERY);
  await sleep(20);
  handler = (url) => (url.startsWith('https://slow') || url.startsWith('https://SLOW') ? json({ data: { ok: 3 } }) : json({ data: {} }));
  const alias = await rejection(new WikiClient('https://SLOW3.example:443', 't', 2000).request(QUERY), 300);
  check(`S6: "https://SLOW3.example:443" shares the gate of "https://slow3.example" (${alias})`, alias === 'GUARD-TIMEOUT');
  releases.forEach((r) => r());
  await Promise.allSettled([slowA2]);
  await sleep(50);

  // The SDK aborts with a reason (string or Error); undici rejects with that reason as is.
  const acReason = new AbortController();
  handler = async (_u, init) => {
    await sleep(50);
    if (init.signal?.aborted) throw init.signal.reason;
    return json({ data: {} });
  };
  const withReason = rejection(new WikiClient(URL_, 't', 5000, { signal: acReason.signal, retries: 2 }).request(QUERY));
  setTimeout(() => acReason.abort('user pressed stop'), 10);
  check('S6: a cancellation with a reason is reported as cancelled, not as a network error', /cancel/i.test(await withReason));

  // Cancelled while queued for a slot: leaves the queue at once.
  releases.length = 0;
  handler = (url) =>
    url.startsWith('https://slow')
      ? new Promise<Response>((r) => releases.push(() => r(json({ data: { ok: 1 } }))))
      : json({ data: {} });
  const holder = new WikiClient('https://slow4.example', 't', 3000).request(QUERY);
  await sleep(20);
  const acQueue = new AbortController();
  const queued = rejection(new WikiClient('https://slow4.example', 't', 3000, { signal: acQueue.signal }).request(QUERY), 500);
  setTimeout(() => acQueue.abort(), 20);
  check('S6: a call cancelled while queued leaves the queue at once', /cancel/i.test(await queued));
  releases.forEach((r) => r());
  await Promise.allSettled([holder]);

  // Cancelled during the target check (DNS): returns at once.
  const acCheck = new AbortController();
  const checking = rejection(
    new WikiClient('https://e.example', 't', 3000, { signal: acCheck.signal, assertTarget: () => new Promise(() => {}) }).request(QUERY),
    500,
  );
  setTimeout(() => acCheck.abort(), 20);
  check('S6: a call cancelled during the target check returns at once', /cancel/i.test(await checking));

  // One budget for target check + queue + request (A-47/A-46). Like undici, the stub
  // rejects as soon as the signal aborts.
  handler = (_u, init) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(json({ data: {} })), 200);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  const t0 = Date.now();
  const budget = await rejection(
    new WikiClient('https://f.example', 't', 300, { assertTarget: () => sleep(200).then(() => undefined) }).request(QUERY),
    2000,
  );
  check(`S6: target check and request share one timeout budget (${budget}, ${Date.now() - t0} ms)`, /timed out/i.test(budget) && Date.now() - t0 < 380);

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
