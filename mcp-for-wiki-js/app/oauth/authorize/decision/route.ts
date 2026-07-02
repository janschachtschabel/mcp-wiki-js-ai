import { cookies } from 'next/headers';
import { decryptString, encryptString } from '../../../../lib/oauth/crypto';
import { resolveIssuer } from '../../../../lib/oauth/metadata';
import {
  issueAuthorizationCode,
  OAuthError,
  validateAuthorizeRequest,
  type AuthorizeParams,
} from '../../../../lib/oauth/service';
import { oauthEnabled } from '../../../../lib/oauth/store';
import { fetchIdentity, loginTfa, loginWithCredentials, type LoginOutcome } from '../../../../lib/oauth/wiki-login';
import {
  identityFromCookies,
  isSecureRequest,
  meCookieHeader,
  meCookieValue,
  sameOrigin,
  wikiBaseUrl,
} from '../../../../lib/oauth/web';

export const dynamic = 'force-dynamic';

/**
 * Handles the authorize form POST (consent / credentials / 2FA step).
 * Success → 303 redirect to the client's redirect_uri with the auth code.
 * Wrong password → 303 back to the authorize page with a message.
 * 2FA required → 303 back to the authorize page with the encrypted
 * continuation token, where the code form is rendered.
 */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return new Response('OAuth is not enabled on this deployment.', { status: 404 });
  const issuer = resolveIssuer(req);
  if (!sameOrigin(req, issuer)) return new Response('Cross-origin form post rejected.', { status: 403 });

  const form = new URLSearchParams(await req.text());
  const p: AuthorizeParams = {
    clientId: form.get('client_id') ?? '',
    redirectUri: form.get('redirect_uri') ?? '',
    codeChallenge: form.get('code_challenge') ?? '',
    codeChallengeMethod: form.get('code_challenge_method') ?? '',
    state: form.get('state') || undefined,
  };

  // Validate BEFORE any redirect — we never send the browser to an unregistered URI.
  try {
    validateAuthorizeRequest(p);
  } catch (e) {
    const msg = e instanceof OAuthError ? e.message : 'Invalid authorization request.';
    return new Response(`Anfrage abgelehnt: ${msg}`, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  if (form.get('action') === 'deny') {
    const url = new URL(p.redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (p.state) url.searchParams.set('state', p.state);
    return redirect303(url.toString());
  }

  const mode = form.get('mode') ?? '';
  try {
    if (mode === 'consent') {
      const sso = await identityFromCookies(cookies());
      if (!sso) return backToAuthorize(issuer, p, { force_login: '1', login_error: 'Sitzung abgelaufen — bitte anmelden.' });
      return issueAndRedirect(p, sso.jwt, undefined, req);
    }

    if (mode === 'credentials') {
      const outcome = await loginWithCredentials(wikiBaseUrl(), form.get('username') ?? '', form.get('password') ?? '');
      return handleLoginOutcome(issuer, p, outcome, req);
    }

    if (mode === 'tfa') {
      const continuation = decryptString(form.get('tfa') ?? '');
      const outcome = await loginTfa(wikiBaseUrl(), continuation, form.get('security_code') ?? '');
      return handleLoginOutcome(issuer, p, outcome, req);
    }

    return new Response('Unknown decision mode.', { status: 400 });
  } catch (e) {
    // Unexpected failure: log the details, show the browser a generic line
    // (raw messages can contain the internal wiki endpoint).
    console.error('Authorize decision failed:', e);
    return backToAuthorize(issuer, p, {
      force_login: '1',
      login_error: 'Anmeldung fehlgeschlagen — bitte erneut versuchen.',
    });
  }
}

async function handleLoginOutcome(issuer: string, p: AuthorizeParams, outcome: LoginOutcome, req: Request): Promise<Response> {
  if (outcome.kind === 'tfa') {
    return backToAuthorize(issuer, p, { tfa: encryptString(outcome.continuationToken) });
  }
  if (outcome.kind === 'error') {
    return backToAuthorize(issuer, p, { force_login: '1', login_error: outcome.message.slice(0, 180) });
  }
  return issueAndRedirect(p, outcome.jwt, meCookieValue(outcome.jwt), req);
}

/** Exchange a verified wiki JWT for an auth code and send the browser back to the client. */
async function issueAndRedirect(p: AuthorizeParams, wikiJwt: string, setMeCookie: string | undefined, req: Request): Promise<Response> {
  const identity = await fetchIdentity(wikiBaseUrl(), wikiJwt);
  if (!identity) {
    return new Response('Wiki.js hat die Sitzung nicht bestätigt — bitte erneut versuchen.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const issued = issueAuthorizationCode(p, identity, wikiJwt);
  const headers = new Headers({ Location: issued.redirect, 'Cache-Control': 'no-store' });
  if (setMeCookie) {
    headers.append('Set-Cookie', meCookieHeader(setMeCookie, isSecureRequest(req)));
  }
  return new Response(null, { status: 303, headers });
}

function backToAuthorize(issuer: string, p: AuthorizeParams, extra: Record<string, string>): Response {
  const url = new URL('/oauth/authorize', issuer);
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', p.codeChallengeMethod);
  if (p.state) url.searchParams.set('state', p.state);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return redirect303(url.toString());
}

function redirect303(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}
