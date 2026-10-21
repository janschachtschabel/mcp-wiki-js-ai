import { NextResponse, type NextRequest } from 'next/server';
import { oauthEnabled } from './lib/oauth/crypto';
import { CONSENT_NONCE_HEADER, isSecureRequest, issueConsentNonce, type NonceScope } from './lib/oauth/web';

/**
 * Next.js proxy (formerly middleware), only for the consent page and /me: a
 * server component cannot set cookies, so the page's CSRF nonce is minted here —
 * the cookie goes on the response, the value reaches the page as a request header
 * (set, so a client-sent header of that name is overwritten). See
 * issueConsentNonce in lib/oauth/web.ts.
 */
export function proxy(req: NextRequest): NextResponse {
  if (!oauthEnabled()) return NextResponse.next();
  const sp = req.nextUrl.searchParams;
  const scope: NonceScope =
    req.nextUrl.pathname === '/me'
      ? 'me'
      : { clientId: sp.get('client_id') ?? '', codeChallenge: sp.get('code_challenge') ?? '' };
  const { nonce, cookie } = issueConsentNonce(scope, isSecureRequest(req));
  const headers = new Headers(req.headers);
  headers.set(CONSENT_NONCE_HEADER, nonce);
  const res = NextResponse.next({ request: { headers } });
  res.headers.append('Set-Cookie', cookie);
  return res;
}

export const config = { matcher: ['/oauth/authorize', '/me'] };
