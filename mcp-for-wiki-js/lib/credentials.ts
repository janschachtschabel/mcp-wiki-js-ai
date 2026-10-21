/**
 * Legacy (non-OAuth) credential resolution for /mcp and stdio: which Wiki.js key and
 * instance a request uses, plus the role overlays that key carries.
 *
 * Credential resolution order for the incoming "token" (which may be an alias):
 *   1. WIKIJS_PROFILES[alias]  → authoritative {url, token, preset} (real key stays server-side)
 *   2. WIKIJS_KEY_MAP[alias]   → real token (url/policy from env/headers)
 *   3. used verbatim as a raw Wiki.js key (direct BYOK)
 */
import { parsePolicyConfig, roleConfig, type PolicyConfig } from './permissions';
import { oauthEnabled } from './oauth/crypto';
import { checkCallerUrl, pureByok } from './caller-url';

type Env = Record<string, string | undefined>;
export type HeaderMap = Record<string, string | string[] | undefined> | undefined;

/**
 * A named credential profile (entry of the WIKIJS_PROFILES env map):
 * the real Wiki.js key + instance + optional per-handle policy. The CLIENT only ever
 * sends the alias (the map key) — the real token never leaves the server.
 */
interface Profile {
  /** Non-secret human label for audit/logs (the map KEY is the secret handle token). */
  label?: string;
  /** Optional per-profile instance URL (defaults to the global WIKIJS_URL — usually one wiki for all). */
  url?: string;
  token: string;
  /** Assigned rights role (name from config/roles.json). */
  role?: string;
  /** Legacy alias for `role`. */
  preset?: string;
  /** Optional inline fine-tuning on top of the role. */
  policy?: { categories?: unknown; tools?: unknown };
}

/** The resolved upstream credential of a legacy request. */
export interface Credential {
  /** Real Wiki.js key (never the alias), if any. */
  token?: string;
  baseUrl: string;
  /** Non-secret profile label, if a WIKIJS_PROFILES alias was used. */
  profile?: string;
  /** Assigned role (profile / KEY_MAP default) — tightens the baseline. */
  roleOverlay?: PolicyConfig;
  /** Inline per-profile fine-tuning — tightens further. */
  inlineOverlay?: PolicyConfig;
  /** The caller chose baseUrl in pure BYOK mode: check its resolved addresses before every request. */
  callerTarget?: boolean;
}

export function header(headers: HeaderMap, name: string): string | undefined {
  if (!headers) return undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}

/** Look up a named profile by alias in WIKIJS_PROFILES (JSON: { "<alias>": { url, token, preset, policy } }). */
function resolveProfile(alias: string | undefined, env: Record<string, string | undefined>): Profile | undefined {
  if (!alias || !env.WIKIJS_PROFILES) return undefined;
  try {
    const map = JSON.parse(env.WIKIJS_PROFILES) as Record<string, Profile>;
    const p = map?.[alias];
    if (p && typeof p === 'object' && typeof p.token === 'string') return p;
  } catch {
    /* ignore malformed map */
  }
  return undefined;
}

/** Fallback simple alias→token map (token only; url/policy come from env). Kept for backward compat. */
function resolveAlias(token: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (!token || !env.WIKIJS_KEY_MAP) return token;
  try {
    const map = JSON.parse(env.WIKIJS_KEY_MAP) as Record<string, string>;
    if (map && typeof map === 'object' && typeof map[token] === 'string') return map[token];
  } catch {
    /* ignore malformed map */
  }
  return token;
}

// stdio serves exactly one local user (whoever started the process) and never runs
// OAuth — the env key is that user's credential even if a shared .env also carries
// MCP_SESSION_SECRET or per-user handles (audit R-37). Off by default: only
// bin/stdio.ts turns it on, so the HTTP protections (F-02, R-15) stay intact.
let stdioMode = false;

/** Mark this process as the single-user stdio server (call once at startup). */
export function enableStdioMode(): void {
  stdioMode = true;
}

/** Per-user credential handles are configured → callers must identify themselves. */
function multiUser(env: Record<string, string | undefined>): boolean {
  return Boolean(env.WIKIJS_PROFILES?.trim() || env.WIKIJS_KEY_MAP?.trim());
}

/**
 * Incoming token / alias: X-Wikijs-Token > Authorization Bearer > authInfo > env.
 * `envKey` marks the single-tenant service key (a server-side credential).
 */
function incomingToken(headers: HeaderMap, authToken: string | undefined, env: Env): { token?: string; envKey: boolean } {
  let token = header(headers, 'x-wikijs-token');
  if (!token) {
    const auth = header(headers, 'authorization');
    if (auth && /^bearer\s+/i.test(auth)) token = auth.replace(/^bearer\s+/i, '').trim();
  }
  if (!token && typeof authToken === 'string') token = authToken;
  // Single-tenant env fallback only without OAuth and without per-user handles
  // (WIKIJS_PROFILES / WIKIJS_KEY_MAP, audit R-15) — in a multi-user deployment an
  // empty or missing per-request credential must never borrow the service key.
  let envKey = false;
  if (!token && (stdioMode || (!oauthEnabled(env) && !multiUser(env)))) {
    token = env.WIKIJS_TOKEN || env.WIKIJS_API_KEY || undefined;
    envKey = Boolean(token);
  }
  return { token, envKey };
}

/** Named profile is authoritative: the client supplied only the (secret) alias. */
function fromProfile(profile: Profile, env: Env): Credential {
  // Expose only the non-secret label — never echo the secret alias back anywhere.
  // Assigned role (from config/roles.json) + optional inline fine-tuning.
  const roleOverlay = roleConfig(profile.role ?? profile.preset);
  const inlineOverlay = profile.policy
    ? parsePolicyConfig({ categories: profile.policy.categories, tools: profile.policy.tools })
    : undefined;
  return {
    token: profile.token,
    // URL is usually global (one wiki for all); profile.url is an optional override.
    baseUrl: (profile.url || env.WIKIJS_URL || env.WIKIJS_BASE_URL || '').trim(),
    profile: profile.label ?? '(unlabeled)',
    roleOverlay,
    inlineOverlay,
  };
}

/** KEY_MAP alias, env service key or raw BYOK key; the URL may come from the caller. */
function fromKey(token: string | undefined, envKey: boolean, headers: HeaderMap, authBaseUrl: unknown, env: Env): Credential {
  const realToken = resolveAlias(token, env);
  // A KEY_MAP alias unlocks a SERVER key but carries no role → defaultRole,
  // like a profile without one (R-03). Raw BYOK keys keep the ceiling: there
  // Wiki.js enforces the caller's own key.
  const roleOverlay = realToken !== token ? roleConfig(undefined) : undefined;
  const callerUrl = header(headers, 'x-wikijs-url');
  const baseUrl = (
    (callerUrl ? checkCallerUrl(callerUrl, env, envKey || realToken !== token) : undefined) ||
    (typeof authBaseUrl === 'string' ? authBaseUrl : undefined) ||
    env.WIKIJS_URL ||
    env.WIKIJS_BASE_URL ||
    ''
  ).trim();
  // checkCallerUrl refused a server key with a caller URL, so here it is the caller's own key.
  return { token: realToken, baseUrl, roleOverlay, callerTarget: Boolean(callerUrl) && pureByok(env) };
}

/** Resolve the upstream credential of a legacy (non-OAuth) request. Throws without a wiki URL. */
export function resolveCredential(
  headers: HeaderMap,
  authInfo: { token?: string; extra?: Record<string, unknown> } | undefined,
  env: Env,
): Credential {
  const { token, envKey } = incomingToken(headers, authInfo?.token, env);
  const profile = resolveProfile(token, env);
  const credential = profile ? fromProfile(profile, env) : fromKey(token, envKey, headers, authInfo?.extra?.baseUrl, env);
  if (!credential.baseUrl) {
    throw new Error(
      'No Wiki.js URL configured. Use a WIKIJS_PROFILES alias, send the "X-Wikijs-Url" header, or set WIKIJS_URL.',
    );
  }
  return credential;
}
