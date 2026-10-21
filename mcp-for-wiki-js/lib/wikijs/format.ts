import type { CallToolResult } from '@modelcontextprotocol/server';

/** Standard Wiki.js mutation status payload (`responseResult { ... }`). */
export interface ResponseStatus {
  succeeded: boolean;
  errorCode?: number;
  slug?: string;
  message?: string | null;
}

/** Build a successful tool result. `data` is pretty-printed unless it is a string.
 *  Also mirrors the payload as `structuredContent` (always an object) for MCP clients that
 *  consume structured tool output — the text content stays for backward compatibility. */
export function ok(data: unknown, note?: string): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text: note ? `${note}\n\n${text}` : text }],
    structuredContent: { data },
  };
}

/** A dry-run preview inside a handler: like ok(), but marked `_meta.dryRun` so the
 *  registration layer records it as a preview, not as an executed action. */
export function dryRun(data: unknown, note: string): CallToolResult {
  return { ...ok(data, note), _meta: { dryRun: true } };
}

export function isDryRun(result: CallToolResult): boolean {
  return (result._meta as { dryRun?: unknown } | undefined)?.dryRun === true;
}

/** Key names whose values never belong in a preview (and so the model context). */
const SECRET_KEY = /password|secret|token/i;

/** Deep copy of a JSON-like value with every secret-named key's value replaced (R-19). */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && v != null ? '[redacted]' : redactSecrets(v);
  }
  return out;
}

/** Build an error tool result (isError = true). */
export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `❌ ${message}` }], isError: true };
}

/** Throw a readable error if a Wiki.js mutation did not succeed. */
export function assertOk(rr: ResponseStatus | undefined | null, action: string): void {
  if (!rr) throw new Error(`${action}: Wiki.js returned no responseResult.`);
  if (!rr.succeeded) {
    const detail = rr.message || rr.slug || (rr.errorCode != null ? `errorCode ${rr.errorCode}` : 'unknown error');
    throw new Error(`${action} failed: ${detail}`);
  }
}

/**
 * Decide from a `Content-Length` header whether a response body exceeds a byte
 * cap — so a download can be rejected BEFORE it is buffered into memory.
 * Returns false when the header is absent/unparseable (caller then falls back to
 * a post-read size check), true only when a known length is over the limit.
 */
export function exceedsByteLimit(contentLength: string | null, maxBytes: number): boolean {
  if (!contentLength) return false;
  const len = Number(contentLength);
  return Number.isFinite(len) && len > maxBytes;
}

/** One wildcard token: a star run (`cross` = it contained "**") or a single code point / "?". */
type WildcardToken = { star: true; cross: boolean } | { star: false; ch: string };

/**
 * Compile a shell-style wildcard into a path matcher, anchored at both ends:
 * `*` = any run of characters within ONE path segment, `?` = one character
 * except "/", `**` = any run of characters including "/" (audit R-06).
 * Dynamic programming over (token × path position), no backtracking RegExp, so
 * a pattern like "*a*a*a…b" cannot stall the server (R-27). The pattern is
 * tokenized once; star runs collapse into one token, so every other token
 * consumes a character and a path of n code points dies after ≤ n+1 of them —
 * per-path cost is bounded by the PATH length, not the (client-supplied)
 * pattern length. Works on code points, so "?" matches one emoji.
 */
export function wildcardMatcher(pattern: string): (path: string) => boolean {
  const tokens: WildcardToken[] = [];
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '*') {
      tokens.push({ star: false, ch: chars[i] });
      continue;
    }
    let run = 1;
    while (chars[i + 1] === '*') {
      run++;
      i++;
    }
    tokens.push({ star: true, cross: run > 1 });
  }
  return (rawPath: string) => {
    const path = Array.from(rawPath);
    const n = path.length;
    // reach[j] = the tokens consumed so far can match path[0..j)
    let reach: boolean[] = Array.from({ length: n + 1 }, (_, j) => j === 0);
    for (const tok of tokens) {
      const next: boolean[] = new Array(n + 1).fill(false);
      let alive = false;
      if (tok.star) {
        for (let j = 0; j <= n; j++) {
          next[j] = reach[j] || (j > 0 && next[j - 1] && (tok.cross || path[j - 1] !== '/'));
          alive ||= next[j];
        }
      } else {
        for (let j = 0; j < n; j++) {
          if (reach[j] && (tok.ch === '?' ? path[j] !== '/' : path[j] === tok.ch)) next[j + 1] = alive = true;
        }
      }
      if (!alive) return false;
      reach = next;
    }
    return reach[n];
  };
}

/** One-off form of {@link wildcardMatcher}; compile once when matching many paths. */
export function wildcardMatch(pattern: string, path: string): boolean {
  return wildcardMatcher(pattern)(path);
}

/**
 * Truncate a page's `content` and `render` fields in place if they exceed `limit`
 * chars, leaving a notice so the truncation is never silent. `limit <= 0` disables
 * truncation.
 */
export function truncateContent<T extends { content?: string | null; render?: string | null }>(
  page: T | null,
  limit: number,
): T | null {
  if (!page || limit <= 0) return page;
  for (const field of ['content', 'render'] as const) {
    const value = page[field];
    if (typeof value === 'string' && value.length > limit) {
      page[field] = (value.slice(0, limit) +
        `\n\n[Content truncated: ${value.length} chars total. ` +
        `Re-fetch with a higher maxContentChars (or 0 for no limit) to get the full body.]`) as T[typeof field];
    }
  }
  return page;
}

/** Refuse to write text that still carries a truncation notice — it would replace
 *  the page with its own shortened copy (audit R-31). */
export function assertNotTruncated(content: string | undefined | null): void {
  if (typeof content === 'string' && /\[Content truncated: \d+ chars total\./.test(content)) {
    throw new Error(
      'content contains a "[Content truncated: …]" notice — it is a shortened copy, writing it would cut the page. ' +
        'Re-fetch the page with maxContentChars=0, or use edits=[{find,replace}] instead.',
    );
  }
}
