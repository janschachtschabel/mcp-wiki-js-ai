/**
 * In-memory rate limits for the anonymous endpoints that call Wiki.js or grow
 * the store (R-10, R-11).
 *
 * Why our own: Wiki.js limits login/loginTFA to 5/min per req.ip — but every
 * form login reaches Wiki.js from this server's address, so that bucket is
 * shared by ALL users and five forged posts lock everyone out. Limiting per
 * client IP and per username here keeps one sender from draining it.
 * Only FAILED logins count (recordLogin) — accepted trade-off: someone with a
 * valid wiki account can still spend that shared bucket with real logins.
 *
 * Per process, like the sqlite store (one replica). Fixed windows, bounded key
 * count, no background timer.
 */

import { createHash } from 'node:crypto';
import type { LoginOutcome } from './wiki-login';

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Count one attempt. Returns 0 when allowed, else the seconds until the window resets. */
  hit(key: string, now: number = Date.now()): number {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && !this.makeRoom(now)) return 0; // full of running windows: not tracked (see makeRoom)
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return entry.count > this.limit ? this.wait(entry.resetAt, now) : 0;
  }

  /** Whether the NEXT attempt would exceed the limit — counts nothing. Same return as hit(). */
  blocked(key: string, now: number = Date.now()): number {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count >= this.limit ? this.wait(entry.resetAt, now) : 0;
  }

  /** Take back one counted attempt (it turned out not to be a failure). */
  refund(key: string, now: number = Date.now()): void {
    const entry = this.hits.get(key);
    if (entry && entry.resetAt > now && entry.count > 0) entry.count--;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private wait(resetAt: number, now: number): number {
    return Math.max(1, Math.ceil((resetAt - now) / 1000));
  }

  /**
   * Drop expired windows. Running ones are never evicted — that would let a
   * flood of junk keys lift a lockout. If the map is still full, the new key
   * goes untracked (fail open): the per-IP limit still bounds every sender,
   * whereas failing closed would let anyone with enough addresses lock out
   * every account not yet in the map.
   */
  private makeRoom(now: number): boolean {
    if (this.hits.size < this.maxKeys) return true;
    for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
    return this.hits.size < this.maxKeys;
  }
}

const MINUTE = 60 * 1000;

/** Form logins (credentials and 2FA step) per client IP — an office NAT shares it. */
const loginPerIp = new RateLimiter(10, 15 * MINUTE);
/** Password guesses against one account, from anywhere. */
const loginPerUser = new RateLimiter(5, 15 * MINUTE);
/** Open dynamic client registration per client IP. */
const registrationPerIp = new RateLimiter(20, 60 * MINUTE);

/**
 * The client address as seen by the proxy in front of us: the RIGHT-most
 * X-Forwarded-For entry. Every proxy appends the peer it saw, so entries to
 * its left are client-supplied and spoofable. In the appliance that hop is
 * Caddy (it replaces a client-sent header), in Kubernetes the ingress.
 * REQUIRES such a proxy: Next.js only fills the header from the socket when it
 * is absent (`x-forwarded-for ??= remoteAddress`, next/dist/server/base-server),
 * so a client reaching Next directly picks its own "IP" and evades the per-IP
 * limits. Behind further proxies (CDN → Caddy) this is the last proxy's
 * address — then all users share one bucket again (documented limitation).
 */
export function clientIp(headers: Headers): string {
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? 'unknown';
}

/**
 * Longest username we pass on to Wiki.js (audit A-04). The routes refuse longer ones
 * before loginAttempt(), so an anonymous form post cannot park 64 KB keys here.
 */
export const MAX_USERNAME_LENGTH = 256;

/** Case-insensitive, fixed-size limiter key: memory per tracked account stays constant. */
export function limiterUserKey(username: string): string {
  return createHash('sha256').update(username.trim().toLowerCase()).digest('hex');
}
const userKey = limiterUserKey;

/**
 * Call BEFORE Wiki.js; 0 = go ahead, else seconds to wait. Username is
 * case-insensitive. A refused attempt counts nowhere (a locked IP cannot run
 * up the account's counter). An allowed one is reserved on both counters right
 * away, before the await, so a parallel burst cannot slip past the limit;
 * recordLogin() takes the reservation back unless the attempt failed.
 */
export function loginAttempt(headers: Headers, username?: string): number {
  const ip = clientIp(headers);
  const user = username ? userKey(username) : undefined;
  const wait = loginPerIp.blocked(ip) || (user ? loginPerUser.blocked(user) : 0);
  if (wait) return wait;
  loginPerIp.hit(ip);
  if (user) loginPerUser.hit(user);
  return 0;
}

/**
 * Settle a reserved attempt with its Wiki.js outcome. Only failures stay
 * counted, so a school or office behind one NAT address is not locked out by
 * its own successful logins; a success also clears the account's counter. A
 * right password that still needs the 2FA code is no failure. "Wiki
 * unreachable" and Wiki.js' own rate limit say nothing about the secret —
 * counting them would let an outage or a drained upstream bucket lock accounts.
 */
export function recordLogin(headers: Headers, username: string | undefined, outcome: LoginOutcome): void {
  const failed = outcome.kind === 'error' && outcome.code !== 'unavailable' && outcome.code !== 'rate_limited';
  if (failed) return;
  loginPerIp.refund(clientIp(headers));
  if (!username) return;
  if (outcome.kind === 'ok') loginPerUser.reset(userKey(username));
  else loginPerUser.refund(userKey(username));
}

/** Count a client registration; 0 = go ahead, else seconds to wait. */
export function registrationAttempt(headers: Headers): number {
  return registrationPerIp.hit(clientIp(headers));
}
