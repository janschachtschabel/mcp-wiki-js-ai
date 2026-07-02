import { corsPreflightResponse } from '../../../lib/oauth/metadata';
import {
  exchangeAuthorizationCode,
  OAuthError,
  refreshAccessToken,
  type TokenResponse,
} from '../../../lib/oauth/service';
import { oauthEnabled } from '../../../lib/oauth/store';

export const dynamic = 'force-dynamic';

/**
 * OAuth 2.1 token endpoint (public clients, PKCE):
 *   grant_type=authorization_code  code + redirect_uri + client_id + code_verifier
 *   grant_type=refresh_token       refresh_token + client_id   (rotating refresh)
 */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return new Response('OAuth is not enabled on this deployment.', { status: 404 });

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return errorResponse(new OAuthError('invalid_request', 'Body must be application/x-www-form-urlencoded.'));
  }
  const grant = form.get('grant_type') ?? '';

  try {
    let tokens: TokenResponse;
    if (grant === 'authorization_code') {
      tokens = exchangeAuthorizationCode({
        code: form.get('code') ?? '',
        clientId: form.get('client_id') ?? '',
        redirectUri: form.get('redirect_uri') ?? '',
        codeVerifier: form.get('code_verifier') ?? '',
      });
    } else if (grant === 'refresh_token') {
      tokens = refreshAccessToken({
        refreshToken: form.get('refresh_token') ?? '',
        clientId: form.get('client_id') ?? '',
      });
    } else {
      throw new OAuthError('unsupported_grant_type', `Unsupported grant_type "${grant}".`);
    }
    return new Response(JSON.stringify(tokens), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse();
}

function errorResponse(e: unknown): Response {
  const err = e instanceof OAuthError ? e : new OAuthError('invalid_request', 'Token request failed.');
  const status = err.code === 'invalid_client' ? 401 : 400;
  return new Response(JSON.stringify({ error: err.code, error_description: err.message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}
