/**
 * Shared HTTP answers of the OAuth endpoints (R-59): the "OAuth is off" 404
 * and the RFC 6749 §5.2 style JSON error, which keeps client faults (4xx,
 * OAuthError) apart from server faults (500, logged — R-39).
 */

import { OAuthError } from './service';

export function oauthDisabledResponse(): Response {
  return new Response('OAuth is not enabled on this deployment.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

export function jsonResponse(payload: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/**
 * OAuthError → its code with 400 (401 for invalid_client), or the endpoint's
 * own mapping. Anything else is a server fault: logged with `context`, answered
 * with a generic 500 so internal details never reach the client.
 */
export function oauthErrorResponse(
  e: unknown,
  context: string,
  map: (err: OAuthError) => { error: string; status: number } = (err) => ({
    error: err.code,
    status: err.code === 'invalid_client' ? 401 : 400,
  }),
): Response {
  if (e instanceof OAuthError) {
    const { error, status } = map(e);
    return jsonResponse({ error, error_description: e.message }, status);
  }
  console.error(`${context} failed:`, e);
  return jsonResponse({ error: 'server_error', error_description: 'Internal server error.' }, 500);
}
