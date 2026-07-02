import { SERVER_INFO } from '../../../lib/meta';

export const dynamic = 'force-dynamic';

/** Lightweight discovery document advertising the Streamable HTTP endpoint. */
const handler = async (request: Request) => {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') || url.host;
  const baseUrl = process.env.PUBLIC_BASE_URL || `${proto}://${host}`;

  return Response.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description:
      'Wiki.js MCP server with full GraphQL API coverage, per-user API keys and a fine-grained permission policy.',
    transport: {
      type: 'streamable_http',
      url: `${baseUrl}/mcp`,
    },
    authentication: {
      type: 'bearer-or-header',
      hint:
        'Send the Wiki.js API key as `Authorization: Bearer <key>` or `X-Wikijs-Token`, and the instance URL as `X-Wikijs-Url`.',
    },
  });
};

export { handler as GET };
