/**
 * Decide whether an incoming /mcp request is served by the OAuth layer or the
 * legacy path (explicit BYOK header/query, or — when OAuth is off — the
 * single-tenant env token / stdio setup).
 *
 * Security-critical: when OAuth is enabled, a request that carries NO explicit
 * per-request credential MUST go to the OAuth path (→ 401 discovery), never fall
 * back to a single-tenant env token. Otherwise an operator who leaves both
 * MCP_SESSION_SECRET and WIKIJS_TOKEN set would serve /mcp unauthenticated with
 * the env key. Only a credential the caller DELIBERATELY supplied per request
 * (a BYOK bearer key or an X-Wikijs-Token handle) may take the legacy path.
 *
 * The env token is intentionally NOT consulted here: it is a single-tenant
 * fallback that only applies when OAuth is disabled entirely.
 *
 * With OAuth on, the legacy path is OFF unless the operator opts in
 * (WIKIJS_ALLOW_LEGACY=true): the legacy handler has no authentication of its
 * own, so leaving it reachable turns /mcp into an anonymous proxy.
 */
export function shouldUseOAuth(oauthEnabled: boolean, headers: Headers, allowLegacy = false): boolean {
  if (!oauthEnabled) return false;
  if (!allowLegacy) return true;
  const auth = headers.get('authorization') ?? '';
  if (/^bearer\s+mcp_at_/i.test(auth)) return true; // one of our OAuth access tokens
  // An empty handle is no credential: it would let resolveContext fall back to the env token.
  if ((headers.get('x-wikijs-token') ?? '').trim()) return false; // explicit BYOK handle (incl. ?token= injected earlier)
  if (/^bearer\s+/i.test(auth)) return false; // explicit BYOK bearer key
  return true; // nothing explicit → OAuth path issues the 401 + discovery chain
}

/** Operator opt-in for the legacy BYOK/handle path next to OAuth. */
export function legacyAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.WIKIJS_ALLOW_LEGACY || '');
}
