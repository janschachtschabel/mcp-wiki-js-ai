/**
 * OAuth discovery documents (RFC 8414 authorization-server metadata and
 * RFC 9728 protected-resource metadata) plus issuer resolution.
 *
 * The issuer is the public origin of this deployment: PUBLIC_BASE_URL when set
 * (recommended in production), else derived from proxy headers per request.
 */

import { getPublicOrigin } from 'mcp-handler';

export function resolveIssuer(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return new URL(configured).origin;
  return getPublicOrigin(req);
}

/** RFC 8414 document. Public clients only (PKCE, no client secret). */
export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['wiki'],
  };
}

/** RFC 9728 document for the MCP endpoint (<issuer>/mcp). */
export function protectedResourceMetadata(issuer: string): Record<string, unknown> {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ['wiki'],
    bearer_methods_supported: ['header'],
  };
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
};

export function metadataResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300', ...CORS_HEADERS },
  });
}

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
