import { authorizationServerMetadata, corsPreflightResponse, metadataResponse, resolveIssuer } from '../../../lib/oauth/metadata';
import { oauthEnabled } from '../../../lib/oauth/store';
import { oauthDisabledResponse } from '../../../lib/oauth/http';

export const dynamic = 'force-dynamic';

/** RFC 8414 — OAuth authorization-server metadata (only when OAuth is enabled). */
export async function GET(req: Request): Promise<Response> {
  if (!oauthEnabled()) return oauthDisabledResponse();
  return metadataResponse(authorizationServerMetadata(resolveIssuer(req)));
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse();
}
