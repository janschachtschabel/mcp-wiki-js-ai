import { oauthEnabled } from '../../../lib/oauth/crypto';

export const dynamic = 'force-dynamic';

/** Liveness probe for Docker/Kubernetes. No upstream calls — the MCP server
 *  being up must not depend on Wiki.js being up (avoids restart cascades).
 *  With OAuth on, the local session store must answer (R-39): without it no
 *  login, token or tool call can work. */
export async function GET(): Promise<Response> {
  if (!oauthEnabled()) return Response.json({ ok: true });
  try {
    // Lazy: deployments without OAuth never load node:sqlite.
    const { ping } = await import('../../../lib/oauth/store');
    if (ping()) return Response.json({ ok: true, store: 'ok' });
  } catch (e) {
    console.error('Health: OAuth session store unavailable:', e);
  }
  return Response.json({ ok: false, store: 'error' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
