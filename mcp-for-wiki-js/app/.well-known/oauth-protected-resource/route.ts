import { corsPreflightResponse, metadataResponse, protectedResourceMetadata, resolveIssuer } from '../../../lib/oauth/metadata';
import { oauthEnabled } from '../../../lib/oauth/store';
import { oauthDisabledResponse } from '../../../lib/oauth/http';

export const dynamic = 'force-dynamic';

/** RFC 9728 — protected-resource metadata for the /mcp endpoint. */
export async function GET(req: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthDisabledResponse();
  return metadataResponse(protectedResourceMetadata(resolveIssuer(req)));
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse();
}
