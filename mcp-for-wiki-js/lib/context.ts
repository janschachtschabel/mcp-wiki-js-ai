import { WikiClient } from './wikijs/client';
import { Policy, basePolicyFromEnv, parsePolicyConfig, roleConfig } from './permissions';
import { sha256hex } from './oauth/crypto';
import { header, resolveCredential, type HeaderMap } from './credentials';
import { assertPublicTarget } from './caller-url';

export { enableStdioMode } from './credentials';

/**
 * Per-request execution context: which Wiki.js instance + key to talk to, and the
 * effective permission policy (deployment baseline tightened by any overlay).
 */
export interface WikiContext {
  client: WikiClient;
  policy: Policy;
  baseUrl: string;
  hasToken: boolean;
  /** Name of the matched credential profile, if a WIKIJS_PROFILES alias was used. */
  profile?: string;
  /** OAuth session id when the request was authenticated via /oauth (for audit). */
  sessionId?: string;
  /**
   * Non-reversible fingerprint of the upstream credential. Used to partition
   * caches that hold permission-FILTERED upstream data (lib/guardrails.ts) —
   * sharing those across users would leak pages between permission levels.
   */
  credentialKey?: string;
}

/** Short, non-reversible cache-partition key for a credential. */
function fingerprint(token: string | undefined): string {
  return token ? sha256hex(token).slice(0, 16) : 'anon';
}

// The deployment baseline is parsed once. Per-request overlays are layered on top.
const BASE_POLICY = basePolicyFromEnv();

export function basePolicy(): Policy {
  return BASE_POLICY;
}

/** The per-call inputs resolveContext needs: request headers + verified auth (if any). */
export interface ToolExtra {
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
  authInfo?: { token?: string; extra?: Record<string, unknown> };
}

/**
 * Map the MCP SDK v2 handler context (`ctx.http.req` / `ctx.http.authInfo`) onto
 * ToolExtra. Header names are lower-cased by the Fetch `Headers` iterator.
 */
export function toolExtraFromServerContext(ctx: {
  http?: { req?: { headers: Headers }; authInfo?: ToolExtra['authInfo'] };
}): ToolExtra {
  const req = ctx.http?.req;
  return {
    requestInfo: req ? { headers: Object.fromEntries(req.headers.entries()) } : undefined,
    authInfo: ctx.http?.authInfo,
  };
}

/**
 * Untrusted per-request overlays (X-Wikijs-Policy, X-Wikijs-Preset) — can only tighten.
 * Two separate overlays: inside ONE overlay, tools/categories shadow the preset, so a
 * merged object would let the policy header mask the preset (audit R-33).
 */
function withRequestOverlays(policy: Policy, headers: HeaderMap): Policy {
  const preset = header(headers, 'x-wikijs-preset');
  return policy
    .withOverlay(parsePolicyConfig(header(headers, 'x-wikijs-policy')))
    .withOverlay(preset ? { preset } : undefined);
}

/**
 * OAuth session (authInfo.extra.oauth) — the token IS a Wiki.js USER JWT.
 * Wiki.js enforces that user's real groups/page-rules; this server only adds
 * the agent-safety overlay (confirm gates) via WIKIJS_OAUTH_ROLE.
 * Returns undefined when the request is not an OAuth session.
 */
function oauthContext(extra: ToolExtra | undefined, env: Record<string, string | undefined>): WikiContext | undefined {
  const headers = extra?.requestInfo?.headers;
  const authExtra = extra?.authInfo?.extra as
    | { oauth?: boolean; sessionId?: string; label?: string; email?: string }
    | undefined;
  if (!authExtra?.oauth || typeof extra?.authInfo?.token !== 'string') return undefined;
  const baseUrl = (env.WIKIJS_URL || env.WIKIJS_BASE_URL || '').trim();
  if (!baseUrl) throw new Error('WIKIJS_URL must be configured on the server for OAuth sessions.');
  const sessionId = typeof authExtra.sessionId === 'string' ? authExtra.sessionId : undefined;
  const onNewJwt = sessionId
    ? (jwt: string) => {
        // Persist Wiki.js' rolling JWT renewal (fire-and-forget; lazy import
        // keeps node:sqlite out of stdio/serverless runtimes).
        import('./oauth/service')
          .then((m) => m.persistRenewedJwt(sessionId, jwt))
          .catch((e) => console.error('Failed to persist renewed wiki JWT:', e));
      }
    : undefined;
  const oauthRole = roleConfig(env.WIKIJS_OAUTH_ROLE || 'wiki');
  return {
    client: new WikiClient(baseUrl, extra.authInfo.token, undefined, { onNewJwt }),
    policy: withRequestOverlays(BASE_POLICY.withOverlay(oauthRole), headers),
    baseUrl,
    hasToken: true,
    profile: authExtra.label ?? authExtra.email ?? 'oauth-user',
    sessionId,
    credentialKey: fingerprint(extra.authInfo.token),
  };
}

/**
 * Build the context for a tool invocation: an OAuth session, or else the legacy
 * credential (profile handle / KEY_MAP alias / raw BYOK key / env key — see
 * lib/credentials.ts) with its role overlays.
 */
export function resolveContext(extra?: ToolExtra): WikiContext {
  const env = process.env;
  const oauth = oauthContext(extra, env);
  if (oauth) return oauth;

  const cred = resolveCredential(extra?.requestInfo?.headers, extra?.authInfo, env);
  // Layer overlays (all tighten): assigned role → inline fine-tuning → per-request.
  const policy = withRequestOverlays(
    BASE_POLICY.withOverlay(cred.roleOverlay).withOverlay(cred.inlineOverlay),
    extra?.requestInfo?.headers,
  );
  return {
    client: new WikiClient(cred.baseUrl, cred.token, undefined, cred.callerTarget ? { assertTarget: assertPublicTarget } : {}),
    policy,
    baseUrl: cred.baseUrl,
    hasToken: Boolean(cred.token),
    profile: cred.profile,
    credentialKey: fingerprint(cred.token),
  };
}
