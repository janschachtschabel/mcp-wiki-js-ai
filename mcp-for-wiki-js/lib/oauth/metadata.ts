/**
 * OAuth discovery documents (RFC 8414 authorization-server metadata and
 * RFC 9728 protected-resource metadata) plus issuer resolution.
 *
 * The issuer is the public origin of this deployment: PUBLIC_BASE_URL when set
 * (recommended in production), else derived from proxy headers per request.
 * Every page and route derives its public URL from here (R-58).
 */

import { getPublicOrigin } from 'mcp-handler';

/** Origin of PUBLIC_BASE_URL (path and trailing slash dropped), or undefined. */
export function configuredOrigin(env: Record<string, string | undefined> = process.env): string | undefined {
  const configured = (env.PUBLIC_BASE_URL ?? '').trim();
  return configured ? new URL(configured).origin : undefined;
}

/**
 * Public origin for a request — or for bare headers (server components only
 * have headers()). Without PUBLIC_BASE_URL it follows X-Forwarded-Host/-Proto,
 * then the Host header.
 */
export function resolveIssuer(source: { headers: Headers; url?: string }): string {
  const configured = configuredOrigin();
  if (configured) return configured;
  const url = source.url ?? `http://${source.headers.get('host') ?? 'localhost'}`;
  return getPublicOrigin({ headers: source.headers, url } as Request);
}

/** RFC 8414 document. Public clients only (PKCE, no client secret). */
export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
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

/**
 * Cacheable only when the issuer is fixed by PUBLIC_BASE_URL. Derived from
 * request headers, a shared cache would hand one Host's document to another
 * (R-24) — so then no-store.
 */
export function metadataResponse(payload: Record<string, unknown>): Response {
  const cache = configuredOrigin() ? 'public, max-age=300' : 'no-store';
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...CORS_HEADERS },
  });
}

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
