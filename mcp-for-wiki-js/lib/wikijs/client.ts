/**
 * Minimal, dependency-free GraphQL client for Wiki.js.
 *
 * Uses the global `fetch` (Node >=18 and the Vercel/Next runtime), so it works
 * in serverless functions without bundling a GraphQL client library.
 *
 * OVERLOAD PROTECTION: all upstream requests pass through a concurrency gate per wiki
 * (WIKIJS_MAX_CONCURRENCY per base URL — audit A-20). This caps how many simultaneous
 * GraphQL requests the server fires at one Wiki.js so it can never exhaust that wiki's DB
 * connection pool, while a slow wiki cannot starve requests to another one (BYOK). When the
 * gate is full, requests queue briefly; if no slot frees within the timeout, the request is
 * shed with a clear "busy" error instead of piling up into a 60 s pool-acquire hang.
 *
 * NOTE (Vercel/serverless): the gate is per Node instance. A single warm instance serving
 * concurrent invocations is capped globally; if Vercel scales to N instances the effective
 * cap is N × WIKIJS_MAX_CONCURRENCY. Keep (expected instances × cap) below the Wiki.js
 * sustained ceiling. For a hard global cap across instances, back the gate with Redis.
 */

import { Kind, parse } from 'graphql';
import { exceedsByteLimit } from './format';

export interface GraphQLErrorEntry {
  message: string;
  extensions?: Record<string, unknown>;
}

/**
 * Integer env setting: `def` when unset/unparseable or outside [min, max]. Unlike
 * `Number(x) || def`, a valid 0 survives (WIKIJS_RETRIES=0 disables retries)
 * and a negative timeout can't turn into an immediate abort (audit R-36).
 */
export function envInt(raw: string | undefined, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

/** Above 2^31-1 ms Node fires a timer after 1 ms, so every request would "time out" (review #9). */
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = envInt(process.env.WIKIJS_TIMEOUT_MS, 30_000, 1, MAX_TIMEOUT_MS);
const MAX_CONCURRENCY = envInt(process.env.WIKIJS_MAX_CONCURRENCY, 8, 1);
const MAX_RETRIES = envInt(process.env.WIKIJS_RETRIES, 2, 0);
/** Cap on a buffered GraphQL response body (audit R-45). */
const MAX_RESPONSE_BYTES = envInt(process.env.WIKIJS_MAX_RESPONSE_BYTES, 16 * 1024 * 1024, 1024);
/** The /u upload endpoint answers "ok" or a small JSON object (audit A-45). */
const MAX_UPLOAD_RESPONSE_BYTES = 64 * 1024;
/** What a proxy in front of a (re)starting Wiki.js answers; worth retrying for reads (A-47). */
const PROXY_UNAVAILABLE = new Set([502, 503, 504]);
const CANCELLED = 'Request cancelled by the MCP client — nothing more is sent to Wiki.js.';

/**
 * Node fetch failure codes (`err.cause.code`) raised BEFORE any request byte is
 * written (no address / no connection). Anything else — ECONNRESET,
 * UND_ERR_SOCKET, … — can happen after the request was sent, so a mutation must
 * not be repeated on it (audit R-32).
 */
const NOTHING_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Thrown when fetch failed at the network level. `nothingSent` = safe to retry even a mutation. */
export class WikiConnectionError extends Error {
  constructor(
    message: string,
    readonly nothingSent = false,
  ) {
    super(message);
  }
}

/** Wiki.js answered with a redirect: a configuration problem — never retried. */
export class WikiRedirectError extends WikiConnectionError {}

/** Whether a GraphQL document can change state (any mutation/subscription operation).
 *  Parsed, not pattern-matched (audit R-04); throws on a syntax error. */
export function isWriteDocument(query: string): boolean {
  return parse(query).definitions.some((d) => d.kind === Kind.OPERATION_DEFINITION && d.operation !== 'query');
}

/** For the retry decision: an unparseable document counts as a write (fail safe). */
function isReadOnlyDocument(query: string): boolean {
  try {
    return !isWriteDocument(query);
  } catch {
    return false;
  }
}

function causeCode(err: unknown): string | undefined {
  const cause = err instanceof Error ? (err as Error & { cause?: { code?: unknown } }).cause : undefined;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

/**
 * Map a fetch() rejection. undici reports everything as TypeError("fetch failed")
 * and puts the reason in `cause`: a refused redirect (`redirect: 'error'`) gets its
 * own, non-retried error; anything else becomes a WikiConnectionError that carries
 * the cause text (review 2026-10-21 #5).
 */
function fetchFailure(err: unknown, url: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : undefined;
  if (causeMessage === 'unexpected redirect') {
    return new WikiRedirectError(
      `Wiki.js answered ${url} with a redirect — check WIKIJS_URL / proxy (it must point at Wiki.js itself, ` +
        'with the right scheme and no login gateway in front).',
    );
  }
  const code = causeCode(err);
  const detail = causeMessage ? `: ${causeMessage}` : '';
  const codeNote = code && !detail.includes(code) ? ` (${code})` : '';
  return new WikiConnectionError(
    `Could not reach Wiki.js at ${url}: ${message}${detail}${codeNote}`,
    code !== undefined && NOTHING_SENT_CODES.has(code),
  );
}

/**
 * Read a response body, refusing more than `maxBytes` (declared or actual)
 * instead of buffering it — a huge upstream answer must not tie up memory and
 * the concurrency slot (audit R-45, A-45). `tooLarge` builds the refusal.
 */
async function readCappedBytes(res: Response, maxBytes: number, tooLarge: () => Error): Promise<Uint8Array> {
  if (exceedsByteLimit(res.headers.get('content-length'), maxBytes)) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const bytes = await readCappedBytes(
    res,
    maxBytes,
    () => new Error(`Wiki.js response too large (over ${maxBytes} bytes; see WIKIJS_MAX_RESPONSE_BYTES).`),
  );
  return new TextDecoder().decode(bytes);
}

/** Thrown by download() when the asset's Content-Length exceeds the caller's byte cap. */
export class AssetTooLargeError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Exponential backoff with jitter, capped at 2s. */
const backoffMs = (attempt: number) => Math.min(2000, 150 * 2 ** attempt) + Math.floor(Math.random() * 120);

/**
 * Async counting semaphore: caps concurrent work at `max`, queues the rest FIFO, and
 * rejects (sheds) a queued caller if it can't get a slot within `acquireTimeoutMs`.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(private readonly max: number) {}

  /** Current in-flight count (for tests/diagnostics). */
  get inFlight(): number {
    return this.active;
  }

  /** Nothing running and nobody waiting. */
  get idle(): boolean {
    return this.active === 0 && this.waiters.length === 0;
  }

  async run<T>(fn: () => Promise<T>, acquireTimeoutMs: number): Promise<T> {
    await this.acquire(acquireTimeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(timeoutMs: number): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
      };
      timer = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(
          new Error(
            `Wiki.js gateway busy: ${this.max} concurrent upstream requests already in flight ` +
              `and no slot freed within ${timeoutMs} ms. Try again shortly (raise WIKIJS_MAX_CONCURRENCY ` +
              `only if the Wiki.js DB pool can take it).`,
          ),
        );
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot directly to the next waiter (active count stays the same).
      next.resolve();
    } else {
      this.active--;
    }
  }
}

/** One gate per wiki, shared by every WikiClient talking to it; dropped when idle (A-20). */
const gates = new Map<string, Semaphore>();

async function gated<T>(baseUrl: string, fn: () => Promise<T>, acquireTimeoutMs: number): Promise<T> {
  let gate = gates.get(baseUrl);
  if (!gate) {
    gate = new Semaphore(MAX_CONCURRENCY);
    gates.set(baseUrl, gate);
  }
  try {
    return await gate.run(fn, acquireTimeoutMs);
  } finally {
    if (gate.idle && gates.get(baseUrl) === gate) gates.delete(baseUrl);
  }
}

export interface WikiClientOptions {
  /**
   * Called when Wiki.js returns a renewed user JWT in the `new-jwt` response
   * header (it does so for expired-but-renewable USER tokens on every request).
   * Used by the OAuth layer to keep stored sessions fresh; irrelevant for API keys.
   */
  onNewJwt?: (jwt: string) => void;
  /** Retries after a connection failure (default WIKIJS_RETRIES). */
  retries?: number;
  /**
   * Runs before every upstream request with the base URL and rejects to refuse
   * it. Set only for a caller-chosen URL in pure BYOK mode (lib/credentials.ts →
   * assertPublicTarget); operator-configured targets never pass one.
   */
  assertTarget?: (baseUrl: string) => Promise<void>;
  /** The MCP request's abort signal: a cancelled call stops talking to Wiki.js (A-15). */
  signal?: AbortSignal;
}

export class WikiClient {
  readonly baseUrl: string;
  /** Replaced by a renewed user JWT, so later requests of the same call use it (A-34). */
  private token?: string;
  private readonly timeoutMs: number;
  private readonly onNewJwt?: (jwt: string) => void;
  private readonly retries: number;
  private readonly assertTarget?: (baseUrl: string) => Promise<void>;
  private readonly signal?: AbortSignal;

  constructor(baseUrl: string, token?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS, opts: WikiClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.onNewJwt = opts.onNewJwt;
    this.retries = opts.retries ?? MAX_RETRIES;
    this.assertTarget = opts.assertTarget;
    this.signal = opts.signal;
  }

  /** Use a renewed user JWT from now on and forward it to the session layer. Never throws. */
  private captureRenewedJwt(res: Response): void {
    const renewed = res.headers.get('new-jwt');
    if (!renewed) return;
    this.token = renewed;
    try {
      this.onNewJwt?.(renewed);
    } catch {
      /* persisting a renewal must never break the actual request */
    }
  }

  private authHeader(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /** Abort on our timeout or on the client's cancellation, whichever comes first. */
  private abortSignal(controller: AbortController): AbortSignal {
    return this.signal ? AbortSignal.any([controller.signal, this.signal]) : controller.signal;
  }

  private throwIfCancelled(): void {
    if (this.signal?.aborted) throw new Error(CANCELLED);
  }

  /**
   * The BYOK target check (DNS lookup) runs before a concurrency slot is taken and
   * is bounded by the request timeout, so a hanging resolver blocks nobody (A-46).
   */
  private async checkTarget(): Promise<void> {
    if (!this.assertTarget) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Wiki.js target check timed out after ${this.timeoutMs} ms (${this.baseUrl}).`)),
        this.timeoutMs,
      );
    });
    try {
      await Promise.race([this.assertTarget(this.baseUrl), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  get endpoint(): string {
    return `${this.baseUrl}/graphql`;
  }

  /**
   * Run a GraphQL request with retry on connection failures. Every attempt takes
   * its own concurrency slot, so a backoff never blocks other callers (R-47).
   * Reads retry on any connection failure and on a proxy 502/503/504 (A-47); writes
   * only when nothing was sent (R-32). Retries stop at an overall deadline of one
   * timeout, so a retry chain cannot outlast the invocation (A-47).
   * Never retried: timeouts, redirects, GraphQL errors, other HTTP statuses, cancellation.
   */
  async request<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const readOnly = isReadOnlyDocument(query);
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        this.throwIfCancelled();
        await this.checkTarget();
        return await gated(this.baseUrl, () => this.send<T>(query, variables), this.timeoutMs);
      } catch (err) {
        const retryable =
          err instanceof WikiConnectionError && !(err instanceof WikiRedirectError) && (readOnly || err.nothingSent);
        const backoff = backoffMs(attempt);
        const withinDeadline = Date.now() - startedAt + backoff < this.timeoutMs;
        if (attempt < this.retries && retryable && withinDeadline && !this.signal?.aborted) {
          await sleep(backoff);
          continue;
        }
        throw err;
      }
    }
  }

  private async send<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
    // Abort after timeoutMs — covering headers AND body — so a hung Wiki.js never
    // ties up a serverless invocation or a concurrency slot (R-45).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    let raw: string;
    try {
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...this.authHeader(),
          },
          body: JSON.stringify({ query, variables }),
          signal: this.abortSignal(controller),
          // GraphQL is answered directly; a redirect (e.g. to /login) is never legitimate (R-27).
          redirect: 'error',
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        throw fetchFailure(err, this.endpoint);
      }
      this.captureRenewedJwt(res);
      raw = await readCapped(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.throwIfCancelled();
        throw new Error(`Wiki.js request timed out after ${this.timeoutMs} ms (${this.endpoint}).`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    let body: { data?: T; errors?: GraphQLErrorEntry[] };
    try {
      body = JSON.parse(raw);
    } catch {
      const message =
        `Wiki.js returned a non-JSON response (HTTP ${res.status}) from ${this.endpoint}. ` +
        `First bytes: ${raw.slice(0, 200)}`;
      // A proxy answering for an unavailable Wiki.js: retryable for reads (A-47).
      throw PROXY_UNAVAILABLE.has(res.status) ? new WikiConnectionError(message) : new Error(message);
    }

    if (body.errors && body.errors.length > 0) {
      throw new Error(body.errors.map((e) => e.message).join('; '));
    }
    if (!res.ok) {
      throw new Error(`Wiki.js GraphQL request failed with HTTP ${res.status}`);
    }
    if (body.data === undefined || body.data === null) {
      throw new Error('Wiki.js GraphQL response contained no data.');
    }
    return body.data;
  }

  /**
   * Download an asset by its wiki path (e.g. "uploads/diagram.png"). Wiki.js
   * serves assets on GET /<path> and enforces read:assets + page rules itself.
   *
   * `maxBytes` guards memory: if the response advertises a larger Content-Length
   * the body is NEVER buffered. Wiki.js serves assets with a Content-Length, so
   * this covers the real case; without one the body is read only up to `maxBytes` (A-45).
   */
  async download(path: string, maxBytes = Infinity): Promise<{ data: Uint8Array; mime: string }> {
    this.throwIfCancelled();
    await this.checkTarget();
    return gated(this.baseUrl, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
        const res = await fetch(url, {
          headers: this.authHeader(),
          signal: this.abortSignal(controller),
          // Assets are served directly; a redirect (e.g. to /login) leaves the asset space.
          redirect: 'error',
        }).catch((err) => {
          throw err instanceof Error && err.name === 'AbortError' ? err : fetchFailure(err, url);
        });
        this.captureRenewedJwt(res);
        if (!res.ok) throw new Error(`Asset download failed: HTTP ${res.status} for ${path}`);
        if (exceedsByteLimit(res.headers.get('content-length'), maxBytes)) {
          controller.abort(); // release the body without reading it into memory
          throw new AssetTooLargeError(
            `Asset ${path} is ${res.headers.get('content-length')} bytes, over the ${maxBytes}-byte limit.`,
          );
        }
        const data = await readCappedBytes(
          res,
          maxBytes,
          () => new AssetTooLargeError(`Asset ${path} is over the ${maxBytes}-byte limit.`),
        );
        return { data, mime: res.headers.get('content-type') ?? 'application/octet-stream' };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          this.throwIfCancelled();
          throw new Error(`Asset download timed out after ${this.timeoutMs} ms.`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }, this.timeoutMs);
  }

  /** Upload a file via Wiki.js' multipart REST endpoint (/u). Returns {succeeded, message}. */
  async upload(opts: {
    filename: string;
    data: Uint8Array;
    mime?: string;
    folderId?: number;
  }): Promise<{ succeeded: boolean; message?: string }> {
    this.throwIfCancelled();
    await this.checkTarget();
    return gated(this.baseUrl, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const form = new FormData();
        // Wiki.js' /u route reads the folder metadata AND the file from the SAME field name.
        form.append('mediaUpload', JSON.stringify({ folderId: opts.folderId ?? null }));
        // Cast: newer @types/node make Uint8Array generic over ArrayBufferLike, which TS won't
        // narrow to BlobPart's ArrayBufferView<ArrayBuffer>. Runtime is fine.
        const part = opts.data as unknown as BlobPart;
        form.append('mediaUpload', new Blob([part], { type: opts.mime || 'application/octet-stream' }), opts.filename);
        const url = `${this.baseUrl}/u`;
        const res = await fetch(url, {
          method: 'POST',
          headers: this.authHeader(),
          body: form,
          signal: this.abortSignal(controller),
          redirect: 'error',
        }).catch((err) => {
          throw err instanceof Error && err.name === 'AbortError' ? err : fetchFailure(err, url);
        });
        this.captureRenewedJwt(res);
        const answer = await readCappedBytes(
          res,
          MAX_UPLOAD_RESPONSE_BYTES,
          () => new Error(`Wiki.js upload answer too large (HTTP ${res.status}, over ${MAX_UPLOAD_RESPONSE_BYTES} bytes).`),
        );
        const text = new TextDecoder().decode(answer).trim();
        if (res.ok && text === 'ok') return { succeeded: true };
        try {
          const j = JSON.parse(text) as { succeeded?: boolean; message?: string };
          return { succeeded: Boolean(j.succeeded), message: j.message };
        } catch {
          return { succeeded: res.ok, message: res.ok ? undefined : `HTTP ${res.status}: ${text.slice(0, 200)}` };
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          this.throwIfCancelled();
          throw new Error(`Wiki.js upload timed out after ${this.timeoutMs} ms.`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }, this.timeoutMs);
  }
}
