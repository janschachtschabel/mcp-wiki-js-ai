import { SERVER_INFO } from '../../../lib/meta';
import { oauthEnabled } from '../../../lib/oauth/store';
import { resolveIssuer } from '../../../lib/oauth/metadata';

export const dynamic = 'force-dynamic';

/** Lightweight discovery document advertising the Streamable HTTP endpoint. */
const handler = async (request: Request) => {
  const baseUrl = resolveIssuer(request);

  return Response.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description:
      'Wiki.js MCP server with full GraphQL API coverage, per-user API keys and a fine-grained permission policy.',
    transport: {
      type: 'streamable_http',
      url: `${baseUrl}/mcp`,
    },
    authentication: oauthEnabled()
      ? {
          type: 'oauth2',
          protectedResourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource`,
          hint: 'OAuth 2.1 with the Wiki.js login — clients discover it from the 401 on /mcp.',
        }
      : {
          type: 'bearer-or-header',
          hint:
            'Send the Wiki.js API key as `Authorization: Bearer <key>` or `X-Wikijs-Token`, and the instance URL as `X-Wikijs-Url`.',
        },
  });
};

export { handler as GET };
