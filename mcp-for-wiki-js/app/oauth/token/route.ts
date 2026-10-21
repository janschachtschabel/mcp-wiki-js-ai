import { corsPreflightResponse, resolveIssuer } from '../../../lib/oauth/metadata';
import {
  exchangeAuthorizationCode,
  OAuthError,
  refreshAccessToken,
  validateResource,
  type TokenResponse,
} from '../../../lib/oauth/service';
import { oauthEnabled } from '../../../lib/oauth/store';
import { jsonResponse, oauthDisabledResponse, oauthErrorResponse } from '../../../lib/oauth/http';
import { FORM_BODY_LIMIT, readBody } from '../../../lib/body-limit';

export const dynamic = 'force-dynamic';

/**
 * OAuth 2.1 token endpoint (public clients, PKCE):
 *   grant_type=authorization_code  code + redirect_uri + client_id + code_verifier
 *   grant_type=refresh_token       refresh_token + client_id   (rotating refresh)
 * An optional RFC 8707 `resource` must name this server's /mcp.
 */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthDisabledResponse();

  const body = await readBody(req, FORM_BODY_LIMIT);
  if (body instanceof Response) return body;
  const form = new URLSearchParams(body);
  const grant = form.get('grant_type') ?? '';

  try {
    validateResource(form.get('resource') ?? undefined, resolveIssuer(req));
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
    return jsonResponse(tokens, 200, { Pragma: 'no-cache' });
  } catch (e) {
    return oauthErrorResponse(e, 'Token request');
  }
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse();
}
