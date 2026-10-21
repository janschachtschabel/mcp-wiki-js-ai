import { resolveIssuer } from '../../../lib/oauth/metadata';
import { oauthEnabled } from '../../../lib/oauth/store';
import { oauthDisabledResponse } from '../../../lib/oauth/http';
import { consentNonceValid, identityFromCookies, isSecureRequest, isWikiAdmin, requestCookies, sameOrigin } from '../../../lib/oauth/web';
import { FORM_BODY_LIMIT, readBody } from '../../../lib/body-limit';

export const dynamic = 'force-dynamic';

/** Revoke an OAuth session: users their OWN, wiki admins any (immediate effect).
 *  Needs the nonce of a /me page rendered in THIS browser (issueConsentNonce). */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthDisabledResponse();
  const issuer = resolveIssuer(req);
  if (!sameOrigin(req, issuer)) return new Response('Cross-origin form post rejected.', { status: 403 });

  const body = await readBody(req, FORM_BODY_LIMIT);
  if (body instanceof Response) return body;
  const form = new URLSearchParams(body);
  if (!consentNonceValid(requestCookies(req), form.get('csrf') ?? '', 'me', isSecureRequest(req))) {
    return new Response('Diese Seite ist abgelaufen — bitte /me neu laden und erneut absenden.', { status: 403 });
  }

  const me = await identityFromCookies(requestCookies(req), isSecureRequest(req));
  if (!me) return new Response(null, { status: 303, headers: { Location: `${issuer}/me` } });
  const sessionId = form.get('session_id') ?? '';
  const store = await import('../../../lib/oauth/store');
  const session = store.getSessionById(sessionId);
  // Ownership by wiki user id (R-41); rows from before R-41 carry none and fall
  // back to the email. Foreign sessions only for wiki admins (permission probe
  // against Wiki.js itself, not a role guess).
  const own = session && (session.userId !== null ? session.userId === me.identity.id : session.userEmail === me.identity.email);
  if (session && (own || (await isWikiAdmin(me.jwt)))) {
    store.revokeSession(session.id);
  }
  return new Response(null, { status: 303, headers: { Location: `${issuer}/me`, 'Cache-Control': 'no-store' } });
}
