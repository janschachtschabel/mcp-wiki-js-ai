import { resolveIssuer } from '../../../../lib/oauth/metadata';
import {
  authorizationResponseUrl,
  issueAuthorizationCode,
  validateAuthorizeRequest,
  validateResource,
  type AuthorizeParams,
} from '../../../../lib/oauth/service';
import { oauthEnabled } from '../../../../lib/oauth/store';
import { oauthDisabledResponse } from '../../../../lib/oauth/http';
import { authorizeErrorText, type LoginErrorCode } from '../../../../lib/oauth/messages';
import { MAX_USERNAME_LENGTH, loginAttempt, recordLogin } from '../../../../lib/oauth/rate-limit';
import { fetchIdentity, loginTfa, loginWithCredentials, type LoginOutcome } from '../../../../lib/oauth/wiki-login';
import {
  clearTfaCookieHeader,
  consentNonceValid,
  identityFromCookies,
  isSecureRequest,
  meCookieHeader,
  meCookieValue,
  requestCookies,
  sameOrigin,
  tfaContinuation,
  tfaCookieHeader,
  userNavigation,
  wikiBaseUrl,
} from '../../../../lib/oauth/web';
import { FORM_BODY_LIMIT, readBody } from '../../../../lib/body-limit';

export const dynamic = 'force-dynamic';

/**
 * Handles the authorize form POST (consent / credentials / 2FA step).
 * Success → 303 redirect to the client's redirect_uri with the auth code.
 * Login problem → 303 back to the authorize page with a fixed error code.
 * 2FA required → 303 back to the authorize page in the 2FA step; the wiki's
 * continuation token travels in a bound, short-lived HttpOnly cookie.
 * Every mode needs the nonce of a consent page rendered in THIS browser
 * (issueConsentNonce): Origin and Fetch Metadata cannot tell our page from a
 * <form> that a wiki author put into a wiki page on the same origin.
 */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthDisabledResponse();
  const issuer = resolveIssuer(req);
  if (!sameOrigin(req, issuer)) return plain('Cross-origin form post rejected.', 403);
  if (!userNavigation(req)) return plain('Die Freigabe ist nur per Klick auf der Freigabeseite möglich.', 403);

  const body = await readBody(req, FORM_BODY_LIMIT);
  if (body instanceof Response) return body;
  const form = new URLSearchParams(body);
  const p: AuthorizeParams = {
    clientId: form.get('client_id') ?? '',
    redirectUri: form.get('redirect_uri') ?? '',
    codeChallenge: form.get('code_challenge') ?? '',
    codeChallengeMethod: form.get('code_challenge_method') ?? '',
    state: form.get('state') || undefined,
    resource: form.get('resource') || undefined,
  };

  const secure = isSecureRequest(req);
  if (!consentNonceValid(requestCookies(req), form.get('csrf') ?? '', p, secure)) {
    return plain('Diese Freigabeseite ist abgelaufen oder wurde in einem anderen Tab neu geöffnet — bitte die Verbindung in der Anwendung neu starten.', 403);
  }

  // Validate BEFORE any redirect — we never send the browser to an unregistered URI.
  try {
    validateAuthorizeRequest(p);
    validateResource(p.resource, issuer);
  } catch (e) {
    return plain(`Anfrage abgelehnt: ${authorizeErrorText(e)}`, 400);
  }

  if (form.get('action') === 'deny') {
    return redirect303(authorizationResponseUrl(p, issuer, { error: 'access_denied' }));
  }

  const mode = form.get('mode') ?? '';
  try {
    if (mode === 'consent') {
      const sso = await identityFromCookies(requestCookies(req), secure);
      if (!sso) return backToAuthorize(issuer, p, 'session_expired');
      return issueAndRedirect(issuer, p, sso.jwt, []);
    }

    if (mode === 'credentials') {
      const username = form.get('username') ?? '';
      if (username.length > MAX_USERNAME_LENGTH) return backToAuthorize(issuer, p, 'invalid_credentials');
      if (loginAttempt(req.headers, username)) return backToAuthorize(issuer, p, 'rate_limited');
      const outcome = await loginWithCredentials(wikiBaseUrl(), username, form.get('password') ?? '');
      recordLogin(req.headers, username, outcome);
      return handleLoginOutcome(issuer, p, outcome, username, secure);
    }

    if (mode === 'tfa') {
      const continuation = tfaContinuation(requestCookies(req), p, secure);
      if (!continuation) return backToAuthorize(issuer, p, 'tfa_expired', [clearTfaCookieHeader(secure)]);
      if (loginAttempt(req.headers, continuation.username)) {
        return backToAuthorize(issuer, p, 'rate_limited', [clearTfaCookieHeader(secure)]);
      }
      const outcome = await loginTfa(wikiBaseUrl(), continuation.token, form.get('security_code') ?? '');
      recordLogin(req.headers, continuation.username, outcome);
      // Wiki.js consumes the continuation on every attempt — never reuse the cookie.
      return handleLoginOutcome(issuer, p, outcome, continuation.username, secure, [clearTfaCookieHeader(secure)]);
    }

    return plain('Unknown decision mode.', 400);
  } catch (e) {
    // Unexpected failure: details to the log, a fixed code to the browser.
    console.error('Authorize decision failed:', e);
    return backToAuthorize(issuer, p, 'failed');
  }
}

async function handleLoginOutcome(
  issuer: string,
  p: AuthorizeParams,
  outcome: LoginOutcome,
  username: string,
  secure: boolean,
  cookies: string[] = [],
): Promise<Response> {
  if (outcome.kind === 'tfa') {
    const url = authorizeUrl(issuer, p);
    url.searchParams.set('step', 'tfa');
    return redirect303(url.toString(), [...cookies, tfaCookieHeader(outcome.continuationToken, p, username, secure)]);
  }
  if (outcome.kind === 'error') return backToAuthorize(issuer, p, outcome.code, cookies);
  return issueAndRedirect(issuer, p, outcome.jwt, [...cookies, meCookieHeader(meCookieValue(outcome.jwt), secure)]);
}

/** Exchange a verified wiki JWT for an auth code and send the browser back to the client. */
async function issueAndRedirect(issuer: string, p: AuthorizeParams, wikiJwt: string, cookies: string[]): Promise<Response> {
  const identity = await fetchIdentity(wikiBaseUrl(), wikiJwt);
  if (!identity) return plain('Wiki.js hat die Sitzung nicht bestätigt — bitte erneut versuchen.', 400);
  const issued = issueAuthorizationCode(p, identity, wikiJwt, issuer);
  return redirect303(issued.redirect, cookies);
}

function authorizeUrl(issuer: string, p: AuthorizeParams): URL {
  const url = new URL('/oauth/authorize', issuer);
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', p.codeChallengeMethod);
  if (p.state) url.searchParams.set('state', p.state);
  if (p.resource) url.searchParams.set('resource', p.resource);
  return url;
}

/** Back to the login form with a fixed error code (R-22). */
function backToAuthorize(issuer: string, p: AuthorizeParams, error: LoginErrorCode, cookies: string[] = []): Response {
  const url = authorizeUrl(issuer, p);
  url.searchParams.set('force_login', '1');
  url.searchParams.set('login_error', error);
  return redirect303(url.toString(), cookies);
}

function redirect303(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}

function plain(text: string, status: number): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
