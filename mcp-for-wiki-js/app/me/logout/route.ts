import { resolveIssuer } from '../../../lib/oauth/metadata';
import { clearMeCookieHeader, consentNonceValid, isSecureRequest, requestCookies, sameOrigin } from '../../../lib/oauth/web';
import { FORM_BODY_LIMIT, readBody } from '../../../lib/body-limit';

export const dynamic = 'force-dynamic';

/** Clears OUR mcp_me cookie only — the wiki's own session is untouched.
 *  Needs the nonce of a /me page rendered in THIS browser (issueConsentNonce). */
export async function POST(req: Request): Promise<Response> {
  const issuer = resolveIssuer(req);
  if (!sameOrigin(req, issuer)) return new Response('Cross-origin form post rejected.', { status: 403 });
  const body = await readBody(req, FORM_BODY_LIMIT);
  if (body instanceof Response) return body;
  if (!consentNonceValid(requestCookies(req), new URLSearchParams(body).get('csrf') ?? '', 'me', isSecureRequest(req))) {
    return new Response('Diese Seite ist abgelaufen — bitte /me neu laden und erneut absenden.', { status: 403 });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `${issuer}/me`, 'Set-Cookie': clearMeCookieHeader(isSecureRequest(req)), 'Cache-Control': 'no-store' },
  });
}
