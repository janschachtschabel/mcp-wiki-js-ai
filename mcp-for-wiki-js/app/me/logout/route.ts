import { resolveIssuer } from '../../../lib/oauth/metadata';
import { clearMeCookieHeader, sameOrigin } from '../../../lib/oauth/web';

export const dynamic = 'force-dynamic';

/** Clears OUR mcp_me cookie only — the wiki's own session is untouched. */
export async function POST(req: Request): Promise<Response> {
  const issuer = resolveIssuer(req);
  if (!sameOrigin(req, issuer)) return new Response('Cross-origin form post rejected.', { status: 403 });
  return new Response(null, {
    status: 303,
    headers: { Location: `${issuer}/me`, 'Set-Cookie': clearMeCookieHeader(), 'Cache-Control': 'no-store' },
  });
}
