import { cookies } from 'next/headers';
import { resolveIssuer } from '../../../lib/oauth/metadata';
import { oauthEnabled } from '../../../lib/oauth/store';
import { identityFromCookies, isWikiAdmin, sameOrigin } from '../../../lib/oauth/web';

export const dynamic = 'force-dynamic';

/** Revoke an OAuth session: users their OWN, wiki admins any (immediate effect). */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return new Response('OAuth is not enabled on this deployment.', { status: 404 });
  const issuer = resolveIssuer(req);
  if (!sameOrigin(req, issuer)) return new Response('Cross-origin form post rejected.', { status: 403 });

  const me = await identityFromCookies(await cookies());
  if (!me) return new Response(null, { status: 303, headers: { Location: `${issuer}/me` } });

  const form = new URLSearchParams(await req.text());
  const sessionId = form.get('session_id') ?? '';
  const store = await import('../../../lib/oauth/store');
  const session = store.getSessionById(sessionId);
  // Ownership check — foreign sessions only for wiki admins (permission probe
  // against Wiki.js itself, not a role guess).
  if (session && (session.userEmail === me.identity.email || (await isWikiAdmin(me.jwt)))) {
    store.revokeSession(session.id);
  }
  return new Response(null, { status: 303, headers: { Location: `${issuer}/me`, 'Cache-Control': 'no-store' } });
}
