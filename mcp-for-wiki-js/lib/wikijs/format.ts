import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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

/** Convert a shell-style wildcard (`*`, `?`) into an anchored RegExp. */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Truncate a page's `content` field in place if it exceeds `limit` chars, leaving a
 * notice so the truncation is never silent. `limit <= 0` disables truncation.
 */
export function truncateContent<T extends { content?: string | null }>(page: T | null, limit: number): T | null {
  if (page && typeof page.content === 'string' && limit > 0 && page.content.length > limit) {
    page.content =
      page.content.slice(0, limit) +
      `\n\n[Content truncated: ${page.content.length} chars total. ` +
      `Re-fetch with a higher maxContentChars (or 0 for no limit) to get the full body.]`;
  }
  return page;
}
