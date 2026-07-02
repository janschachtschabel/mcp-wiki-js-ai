import { corsPreflightResponse } from '../../../lib/oauth/metadata';
import { OAuthError, registerClient } from '../../../lib/oauth/service';
import { oauthEnabled } from '../../../lib/oauth/store';

export const dynamic = 'force-dynamic';

/**
 * RFC 7591 Dynamic Client Registration — open (as the MCP spec expects), but
 * only public PKCE clients come out of it: no secrets are issued, and a
 * registration grants nothing by itself (authorization still requires a
 * Wiki.js login in the user's browser).
 */
export async function POST(req: Request): Promise<Response> {
  if (!oauthEnabled()) return new Response('OAuth is not enabled on this deployment.', { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new OAuthError('invalid_request', 'Body must be JSON.'));
  }
  try {
    const result = registerClient(body);
    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse();
}

function errorResponse(e: unknown): Response {
  const err = e instanceof OAuthError ? e : new OAuthError('invalid_request', 'Registration failed.');
  // RFC 7591 uses "invalid_redirect_uri" / "invalid_client_metadata" error codes.
  const code = err.code === 'invalid_redirect_uri' ? 'invalid_redirect_uri' : 'invalid_client_metadata';
  return new Response(JSON.stringify({ error: code, error_description: err.message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
