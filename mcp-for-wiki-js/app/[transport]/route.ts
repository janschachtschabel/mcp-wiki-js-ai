import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { registerAll } from '../../lib/register';
import { SERVER_INFO, INSTRUCTIONS } from '../../lib/meta';
import { oauthEnabled } from '../../lib/oauth/store';

export const dynamic = 'force-dynamic';
// 60s deploys on every Vercel plan (incl. Hobby). Pro/Enterprise can raise this.
export const maxDuration = 60;

/**
 * MCP endpoint for the Streamable HTTP transport, served at /mcp.
 *
 * Stateless: a fresh MCP server is initialised per request, so the handler scales
 * on Vercel without shared session state.
 *
 * Per-user Wiki.js credentials + policy are read inside each tool call (lib/context.ts)
 * from request HEADERS — Authorization / X-Wikijs-Token / X-Wikijs-Url / X-Wikijs-Policy.
 *
 * Some MCP clients (claude.ai web custom connectors, ChatGPT developer mode) do NOT
 * let you set custom headers. For those, the same values may be passed as URL QUERY
 * parameters on the connector URL, e.g.
 *     https://<deploy>/mcp?url=https://wiki.example.org&token=<api-key-or-alias>
 * The wrapper below copies those query params into the equivalent headers (without
 * overriding real headers), so the rest of the server stays header-only.
 */
const mcp = createMcpHandler(
  (server) => {
    registerAll(server);
  },
  {
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  },
  {
    // Routing lives at app/[transport]/route.ts → streamable HTTP endpoint is /mcp.
    basePath: '',
    // SSE needs Redis and is deprecated by the MCP spec; keep only Streamable HTTP.
    disableSse: true,
    maxDuration: 60,
    verboseLogs: process.env.WIKIJS_MCP_VERBOSE === 'true',
  },
);

/**
 * OAuth-authenticated variant of the MCP handler. verifyToken resolves our
 * opaque `mcp_at_*` access tokens to a stored session and hands the (decrypted)
 * Wiki.js USER JWT to the tools via authInfo — Wiki.js then enforces exactly
 * that user's groups + page rules. `required: true` produces the spec-compliant
 * 401 + WWW-Authenticate → resource metadata → OAuth discovery chain.
 *
 * The OAuth service is imported lazily so stdio / legacy deployments without
 * MCP_SESSION_SECRET never touch node:sqlite.
 */
const mcpWithOauth = withMcpAuth(
  mcp,
  async (_req, bearer) => {
    if (!bearer || !bearer.startsWith('mcp_at_')) return undefined;
    const { verifyAccessToken } = await import('../../lib/oauth/service');
    const session = verifyAccessToken(bearer);
    if (!session) return undefined;
    return {
      // The wiki JWT rides in authInfo.token — lib/context.ts already treats
      // authInfo.token as the upstream bearer credential.
      token: session.wikiJwt,
      clientId: session.clientId,
      scopes: ['wiki'],
      expiresAt: session.expiresAtSec,
      extra: { oauth: true, sessionId: session.sessionId, label: session.label, email: session.email },
    };
  },
  {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource',
    // Behind the reverse proxy the public origin comes from PUBLIC_BASE_URL;
    // without it, withMcpAuth falls back to X-Forwarded-* headers.
    ...(process.env.PUBLIC_BASE_URL ? { resourceUrl: new URL(process.env.PUBLIC_BASE_URL).origin } : {}),
  },
);

const QUERY_TO_HEADER: Array<[aliases: string[], header: string, guard: string[]]> = [
  [['token', 'key'], 'x-wikijs-token', ['x-wikijs-token', 'authorization']],
  [['url', 'wiki'], 'x-wikijs-url', ['x-wikijs-url']],
  [['preset'], 'x-wikijs-preset', ['x-wikijs-preset']],
  [['policy'], 'x-wikijs-policy', ['x-wikijs-policy']],
];

/** Legacy (non-OAuth) credentials present? Header/query handle, BYOK key, or single-tenant env. */
function hasLegacyCredentials(headers: Headers): boolean {
  if (headers.has('x-wikijs-token')) return true;
  const auth = headers.get('authorization') ?? '';
  if (/^bearer\s+/i.test(auth) && !/^bearer\s+mcp_at_/i.test(auth)) return true;
  return Boolean(process.env.WIKIJS_TOKEN || process.env.WIKIJS_API_KEY);
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = url.searchParams;

  let request = req;
  if ([...QUERY_TO_HEADER].some(([aliases]) => aliases.some((a) => params.has(a)))) {
    const headers = new Headers(req.headers);
    for (const [aliases, header, guards] of QUERY_TO_HEADER) {
      const value = aliases.map((a) => params.get(a)).find((v) => v);
      if (value && !guards.some((g) => headers.has(g))) headers.set(header, value);
    }
    // Rebuild the request with injected headers (Headers are immutable on the original).
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    request = new Request(req.url, { method: req.method, headers, body });
  }

  // OAuth is active → OUR access tokens (mcp_at_*) always take the OAuth path,
  // even when a single-tenant env token is ALSO configured (mixed setups must
  // not silently forward opaque tokens to Wiki.js as raw keys). Requests with
  // explicit legacy credentials keep working untouched; requests with nothing
  // get the 401 → discovery chain.
  if (oauthEnabled()) {
    const isOurToken = /^bearer\s+mcp_at_/i.test(request.headers.get('authorization') ?? '');
    if (isOurToken || !hasLegacyCredentials(request.headers)) return mcpWithOauth(request);
  }
  return mcp(request);
}

export { handler as GET, handler as POST, handler as DELETE };
