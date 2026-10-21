/**
 * Bounded request-body reading (audit R-09). `await req.text()` buffers whatever
 * an anonymous client sends — enough to OOM the container before any auth check
 * runs. Same approach as the MCP SDK's own reader: refuse a declared
 * Content-Length over the limit, otherwise stop as soon as the limit is crossed.
 */

/** OAuth/me form posts and DCR JSON are tiny; 64 KB is generous. */
export const FORM_BODY_LIMIT = 64 * 1024;
/** Matches the MCP SDK's default (DEFAULT_MAX_REQUEST_BODY_SIZE). */
export const MCP_BODY_LIMIT = 4 * 1024 * 1024;

function payloadTooLarge(limit: number): Response {
  return new Response(`Payload Too Large: request body must not exceed ${limit} bytes.`, {
    status: 413,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** The body as text, or a ready 413 response if it exceeds `limit` bytes. */
export async function readBody(req: Request, limit: number): Promise<string | Response> {
  if (Number(req.headers.get('content-length')) > limit) return payloadTooLarge(limit);
  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel();
        return payloadTooLarge(limit);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}
