import { corsPreflightResponse } from '../../../lib/oauth/metadata';
import { OAuthError, registerClient } from '../../../lib/oauth/service';
import { oauthEnabled } from '../../../lib/oauth/store';
import { jsonResponse, oauthDisabledResponse, oauthErrorResponse } from '../../../lib/oauth/http';
import { registrationAttempt } from '../../../lib/oauth/rate-limit';
import { FORM_BODY_LIMIT, readBody } from '../../../lib/body-limit';

export const dynamic = 'force-dynamic';

/**
 * RFC 7591 Dynamic Client Registration — open (as the MCP spec expects), but
 * only public PKCE clients come out of it: no secrets are issued, and a
 * registration grants nothing by itself (authorization still requires a
 * Wiki.js login in the user's browser). Rate-limited per client IP (R-10).
 */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthDisabledResponse();
  const wait = registrationAttempt(req.headers);
  if (wait) {
    return jsonResponse(
      { error: 'too_many_requests', error_description: 'Too many client registrations from this address — retry later.' },
      429,
      { 'Retry-After': String(wait) },
    );
  }
  const text = await readBody(req, FORM_BODY_LIMIT);
  if (text instanceof Response) return text;
  try {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError('invalid_request', 'Body must be JSON.');
    }
    return jsonResponse(registerClient(body), 201);
  } catch (e) {
    // RFC 7591 §3.2.2 error codes.
    return oauthErrorResponse(e, 'Client registration', (err) => ({
      error: err.code === 'invalid_redirect_uri' ? 'invalid_redirect_uri' : 'invalid_client_metadata',
      status: 400,
    }));
  }
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse();
}
