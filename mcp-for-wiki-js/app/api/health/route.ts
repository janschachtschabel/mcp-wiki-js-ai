export const dynamic = 'force-dynamic';

/** Liveness probe for Docker/Kubernetes. No upstream calls — the MCP server
 *  being up must not depend on Wiki.js being up (avoids restart cascades). */
export async function GET(): Promise<Response> {
  return Response.json({ ok: true });
}
