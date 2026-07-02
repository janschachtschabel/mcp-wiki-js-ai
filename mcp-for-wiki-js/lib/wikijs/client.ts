/**
 * Minimal, dependency-free GraphQL client for Wiki.js.
 *
 * Uses the global `fetch` (Node >=18 and the Vercel/Next runtime), so it works
 * in serverless functions without bundling a GraphQL client library.
 *
 * OVERLOAD PROTECTION: all upstream requests pass through a process-wide concurrency
 * gate (WIKIJS_MAX_CONCURRENCY). This caps how many simultaneous GraphQL requests the
 * server fires at Wiki.js so it can never exhaust the Wiki.js DB connection pool. When the
 * gate is full, requests queue briefly; if no slot frees within the timeout, the request is
 * shed with a clear "busy" error instead of piling up into a 60 s pool-acquire hang.
 *
 * NOTE (Vercel/serverless): the gate is per Node instance. A single warm instance serving
 * concurrent invocations is capped globally; if Vercel scales to N instances the effective
 * cap is N × WIKIJS_MAX_CONCURRENCY. Keep (expected instances × cap) below the Wiki.js
 * sustained ceiling. For a hard global cap across instances, back the gate with Redis.
 */

export interface GraphQLErrorEntry {
  message: string;
  extensions?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.WIKIJS_TIMEOUT_MS) || 30_000;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.WIKIJS_MAX_CONCURRENCY) || 8);
const MAX_RETRIES = Math.max(0, Number(process.env.WIKIJS_RETRIES) || 2);

/** Thrown when a request never reached Wiki.js (DNS/TCP/TLS). Safe to retry — even mutations, since nothing ran. */
export class WikiConnectionError extends Error {}

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

/** Process-wide gate shared by every WikiClient instance. */
const upstreamGate = new Semaphore(MAX_CONCURRENCY);

export interface WikiClientOptions {
  /**
   * Called when Wiki.js returns a renewed user JWT in the `new-jwt` response
   * header (it does so for expired-but-renewable USER tokens on every request).
   * Used by the OAuth layer to keep stored sessions fresh; irrelevant for API keys.
   */
  onNewJwt?: (jwt: string) => void;
}

export class WikiClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly onNewJwt?: (jwt: string) => void;

  constructor(baseUrl: string, token?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS, opts: WikiClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.onNewJwt = opts.onNewJwt;
  }

  /** Forward a renewed user JWT (if any) to the session layer. Never throws. */
  private captureRenewedJwt(res: Response): void {
    if (!this.onNewJwt) return;
    const renewed = res.headers.get('new-jwt');
    if (renewed) {
      try {
        this.onNewJwt(renewed);
      } catch {
        /* persisting a renewal must never break the actual request */
      }
    }
  }

  get endpoint(): string {
    return `${this.baseUrl}/graphql`;
  }

  /** Run a GraphQL request through the concurrency gate, with retry on connection failures. */
  async request<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return upstreamGate.run(() => this.sendWithRetry<T>(query, variables), this.timeoutMs);
  }

  private async sendWithRetry<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<T>(query, variables);
      } catch (err) {
        // Retry ONLY on connection-level failures (request never reached the server → safe even
        // for mutations). Never on timeouts / GraphQL errors / HTTP status.
        if (attempt < MAX_RETRIES && err instanceof WikiConnectionError) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
  }

  private async send<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
    // Abort after timeoutMs so a hung Wiki.js never ties up a serverless invocation.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Wiki.js request timed out after ${this.timeoutMs} ms (${this.endpoint}).`);
      }
      throw new WikiConnectionError(
        `Could not reach Wiki.js at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    this.captureRenewedJwt(res);
    const raw = await res.text();
    let body: { data?: T; errors?: GraphQLErrorEntry[] };
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(
        `Wiki.js returned a non-JSON response (HTTP ${res.status}) from ${this.endpoint}. ` +
          `First bytes: ${raw.slice(0, 200)}`,
      );
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
   */
  async download(path: string): Promise<{ data: Uint8Array; mime: string }> {
    return upstreamGate.run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
        const res = await fetch(url, {
          headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
          signal: controller.signal,
        });
        this.captureRenewedJwt(res);
        if (!res.ok) throw new Error(`Asset download failed: HTTP ${res.status} for ${path}`);
        return {
          data: new Uint8Array(await res.arrayBuffer()),
          mime: res.headers.get('content-type') ?? 'application/octet-stream',
        };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
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
    return upstreamGate.run(async () => {
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
        const res = await fetch(`${this.baseUrl}/u`, {
          method: 'POST',
          headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
          body: form,
          signal: controller.signal,
        });
        this.captureRenewedJwt(res);
        const text = (await res.text()).trim();
        if (res.ok && text === 'ok') return { succeeded: true };
        try {
          const j = JSON.parse(text) as { succeeded?: boolean; message?: string };
          return { succeeded: Boolean(j.succeeded), message: j.message };
        } catch {
          return { succeeded: res.ok, message: res.ok ? undefined : `HTTP ${res.status}: ${text.slice(0, 200)}` };
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Wiki.js upload timed out after ${this.timeoutMs} ms.`);
        }
        throw new WikiConnectionError(
          `Could not reach Wiki.js at ${this.baseUrl}/u: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }, this.timeoutMs);
  }
}
