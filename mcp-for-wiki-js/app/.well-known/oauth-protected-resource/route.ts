import { corsPreflightResponse, metadataResponse, protectedResourceMetadata, resolveIssuer } from '../../../lib/oauth/metadata';
import { oauthEnabled } from '../../../lib/oauth/store';

export const dynamic = 'force-dynamic';

/** RFC 9728 — protected-resource metadata for the /mcp endpoint. */
export async function GET(req: Request): Promise<Response> {
  if (!oauthEnabled()) return new Response('OAuth is not enabled on this deployment.', { status: 404 });
  return metadataResponse(protectedResourceMetadata(resolveIssuer(req)));
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse();
}
