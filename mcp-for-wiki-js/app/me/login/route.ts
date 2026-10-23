import { resolveIssuer } from '../../../lib/oauth/metadata';
import { oauthEnabled } from '../../../lib/oauth/store';
import { oauthDisabledResponse } from '../../../lib/oauth/http';
import type { LoginErrorCode } from '../../../lib/oauth/messages';
import { MAX_USERNAME_LENGTH, loginAttempt, recordLogin } from '../../../lib/oauth/rate-limit';
import { loginWithCredentials } from '../../../lib/oauth/wiki-login';
import {
  consentNonceValid,
  isSecureRequest,
  meCookieHeader,
  meCookieValue,
  requestCookies,
  sameOrigin,
  wikiBaseUrl,
} from '../../../lib/oauth/web';
import { FORM_BODY_LIMIT, readBody } from '../../../lib/body-limit';

export const dynamic = 'force-dynamic';

/** Credentials login for /me (sets the encrypted mcp_me cookie). 2FA accounts
 *  use the wiki itself in the same browser instead — documented on the page.
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
  const username = form.get('username') ?? '';
  if (username.length > MAX_USERNAME_LENGTH) return backToMe(issuer, 'invalid_credentials');
  if (loginAttempt(req.headers, username)) return backToMe(issuer, 'rate_limited');
  const outcome = await loginWithCredentials(wikiBaseUrl(), username, form.get('password') ?? '');
  recordLogin(req.headers, username, outcome);

  if (outcome.kind === 'ok') {
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${issuer}/me`,
        'Set-Cookie': meCookieHeader(meCookieValue(outcome.jwt), isSecureRequest(req)),
        'Cache-Control': 'no-store',
      },
    });
  }
  return backToMe(issuer, outcome.kind === 'tfa' ? 'me_tfa' : outcome.code);
}

/** Back to /me with a fixed error code (R-22). */
function backToMe(issuer: string, error: LoginErrorCode): Response {
  const url = new URL(`${issuer}/me`);
  url.searchParams.set('login_error', error);
  return new Response(null, { status: 303, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
}
