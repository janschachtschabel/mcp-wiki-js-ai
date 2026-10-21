import { corsPreflightResponse } from '../../../lib/oauth/metadata';
import { OAuthError, revokeToken } from '../../../lib/oauth/service';
import { oauthEnabled } from '../../../lib/oauth/store';
import { jsonResponse, oauthDisabledResponse, oauthErrorResponse } from '../../../lib/oauth/http';
import { FORM_BODY_LIMIT, readBody } from '../../../lib/body-limit';

export const dynamic = 'force-dynamic';

/**
 * RFC 7009 token revocation (R-48). Public clients: identified by client_id,
 * no secret. Either token type ends the whole session; an unknown or foreign
 * token still answers 200 (§2.2), so the endpoint reveals nothing.
 */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthDisabledResponse();
  const body = await readBody(req, FORM_BODY_LIMIT);
  if (body instanceof Response) return body;
  const form = new URLSearchParams(body);
  try {
    const token = form.get('token') ?? '';
    if (!token) throw new OAuthError('invalid_request', 'token is required.');
    revokeToken({ token, clientId: form.get('client_id') ?? '' });
    return jsonResponse({}, 200);
  } catch (e) {
    return oauthErrorResponse(e, 'Token revocation');
  }
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse();
}
