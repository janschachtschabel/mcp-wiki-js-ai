/**
 * Upstream concurrency gates (overload protection, see lib/wikijs/client.ts):
 * a counting semaphore and one instance of it per wiki.
 */

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

export async function gated<T>(baseUrl: string, max: number, fn: () => Promise<T>, acquireTimeoutMs: number): Promise<T> {
  let gate = gates.get(baseUrl);
  if (!gate) {
    gate = new Semaphore(max);
    gates.set(baseUrl, gate);
  }
  try {
    return await gate.run(fn, acquireTimeoutMs);
  } finally {
    if (gate.idle && gates.get(baseUrl) === gate) gates.delete(baseUrl);
  }
}
