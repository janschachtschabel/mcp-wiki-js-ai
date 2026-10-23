/**
 * Upstream concurrency gates (overload protection, see lib/wikijs/client.ts):
 * a counting semaphore, one instance of it per wiki, and one over all wikis.
 */

/** Rejection for a caller whose MCP request was cancelled while it waited. */
export class GateCancelledError extends Error {}

/**
 * Async counting semaphore: caps concurrent work at `max`, queues the rest FIFO, and
 * rejects (sheds) a queued caller if it can't get a slot within `acquireTimeoutMs`.
 * A queued caller whose `signal` aborts leaves the queue at once.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  /** `setting` names the env variable to raise in the "busy" message. */
  constructor(
    private readonly max: number,
    private readonly setting = 'WIKIJS_MAX_CONCURRENCY',
  ) {}

  /** Current in-flight count (for tests/diagnostics). */
  get inFlight(): number {
    return this.active;
  }

  /** Nothing running and nobody waiting. */
  get idle(): boolean {
    return this.active === 0 && this.waiters.length === 0;
  }

  async run<T>(fn: () => Promise<T>, acquireTimeoutMs: number, signal?: AbortSignal): Promise<T> {
    await this.acquire(acquireTimeoutMs, signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new GateCancelledError('Cancelled before a slot was free.'));
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
      };
      const onAbort = () => {
        leave();
        reject(new GateCancelledError('Cancelled while waiting for a slot.'));
      };
      const entry = {
        resolve: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      timer = setTimeout(() => {
        leave();
        reject(
          new Error(
            `Wiki.js gateway busy: ${this.max} concurrent upstream requests already in flight ` +
              `and no slot freed within ${timeoutMs} ms. Try again shortly (raise ${this.setting} ` +
              `only if the Wiki.js DB pool can take it).`,
          ),
        );
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
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

/**
 * The gate key of a wiki: origin (lower-case host, default port dropped) plus path,
 * so "https://WIKI.example:443/" and "https://wiki.example" share one gate.
 */
export function gateKey(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return baseUrl;
  }
}

export type Gated = <T>(baseUrl: string, fn: () => Promise<T>, acquireTimeoutMs: number, signal?: AbortSignal) => Promise<T>;

/**
 * One gate per wiki (A-20) — a slow wiki cannot starve the others — inside one
 * gate over all wikis, so callers naming many hosts (pure BYOK) cannot multiply
 * the server's own load. Per-wiki gates are dropped when idle.
 */
export function createGates(perWiki: number, total: number): Gated {
  const gates = new Map<string, Semaphore>();
  const overall = new Semaphore(total, 'WIKIJS_MAX_CONCURRENCY_TOTAL');
  return async (baseUrl, fn, acquireTimeoutMs, signal) => {
    const key = gateKey(baseUrl);
    let gate = gates.get(key);
    if (!gate) {
      gate = new Semaphore(perWiki);
      gates.set(key, gate);
    }
    const deadline = Date.now() + acquireTimeoutMs;
    try {
      // Always per-wiki first, then the overall gate: one fixed order, no deadlock.
      // Both waits share the caller's acquire budget.
      return await gate.run(() => overall.run(fn, Math.max(1, deadline - Date.now()), signal), acquireTimeoutMs, signal);
    } finally {
      if (gate.idle && gates.get(key) === gate) gates.delete(key);
    }
  };
}
