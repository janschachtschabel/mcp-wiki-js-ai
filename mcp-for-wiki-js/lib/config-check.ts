/**
 * Startup configuration check (audit R-03, R-07).
 *
 * The request path tolerates bad config by design (malformed JSON is ignored,
 * unknown presets fall back) — at RUNTIME that keeps one bad header from taking
 * the server down. For OPERATOR config the same leniency fails open: a typo in a
 * role name grants the global ceiling, a short secret silently disables OAuth.
 * So the operator's env is checked once at startup and the server refuses to
 * start on any error (instrumentation.ts, bin/stdio.ts).
 *
 * Role names are checked against the roles loaded at import (built-ins ←
 * config/roles.json ← process.env.WIKIJS_ROLES).
 */
import { ROLES, PRESETS } from './permissions';
import { MIN_SECRET_LENGTH } from './oauth/crypto';
import { pureByok } from './caller-url';

type Env = Record<string, string | undefined>;

export interface ConfigReport {
  errors: string[];
  warnings: string[];
}

function set(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** Parse a JSON env var that must hold an object; record an error otherwise. */
function jsonObject(env: Env, name: string, errors: string[]): Record<string, unknown> | undefined {
  const raw = set(env, name);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push(`${name} is not valid JSON.`);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push(`${name} must be a JSON object.`);
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function knownRoles(): string {
  return Object.keys(ROLES).sort().join(', ');
}

export interface CheckOptions {
  /** stdio never runs OAuth or serves HTTP: skip the checks that only matter there. */
  stdio?: boolean;
}

export function checkConfig(env: Env = process.env, opts: CheckOptions = {}): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!opts.stdio) checkHttpOnly(env, errors, warnings);

  const preset = set(env, 'WIKIJS_PERMISSION_PRESET');
  if (preset && !PRESETS[preset.toLowerCase()]) {
    errors.push(`WIKIJS_PERMISSION_PRESET "${preset}" is not a known role (${knownRoles()}).`);
  }

  jsonObject(env, 'WIKIJS_ROLES', errors);
  jsonObject(env, 'WIKIJS_KEY_MAP', errors);
  jsonObject(env, 'WIKIJS_POLICY', errors);

  const profiles = jsonObject(env, 'WIKIJS_PROFILES', errors);
  if (profiles) {
    // Map keys are secret handles — identify entries by label or position only.
    Object.values(profiles).forEach((p, i) => {
      const entry = p as { label?: unknown; token?: unknown; role?: unknown; preset?: unknown } | null;
      const id = `WIKIJS_PROFILES entry #${i + 1}${typeof entry?.label === 'string' ? ` ("${entry.label}")` : ''}`;
      if (!entry || typeof entry !== 'object') {
        errors.push(`${id} must be an object.`);
        return;
      }
      if (typeof entry.token !== 'string' || !entry.token) errors.push(`${id} has no "token".`);
      const role = entry.role ?? entry.preset;
      if (role !== undefined && (typeof role !== 'string' || !ROLES[role])) {
        errors.push(`${id}: role "${String(role)}" is not a known role (${knownRoles()}).`);
      }
    });
  }

  return { errors, warnings };
}

/** Checks that only matter for the HTTP server (OAuth, anonymous /mcp callers). */
function checkHttpOnly(env: Env, errors: string[], warnings: string[]): void {
  const secret = set(env, 'MCP_SESSION_SECRET');
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    errors.push(
      `MCP_SESSION_SECRET is set but shorter than ${MIN_SECRET_LENGTH} characters. ` +
        'Use e.g. `openssl rand -base64 48`, or unset it to run without OAuth.',
    );
  }
  if (secret && secret.length >= MIN_SECRET_LENGTH && !set(env, 'PUBLIC_BASE_URL')) {
    warnings.push('OAuth is on but PUBLIC_BASE_URL is unset — the issuer is derived from X-Forwarded-* headers.');
  }
  const envToken = set(env, 'WIKIJS_TOKEN') || set(env, 'WIKIJS_API_KEY');
  // Mirrors lib/context.ts: per-user handles disable the anonymous env-token fallback (R-15).
  const multiUser = set(env, 'WIKIJS_PROFILES') || set(env, 'WIKIJS_KEY_MAP');
  // A public URL without a secret usually means a broken OAuth setup (e.g. a
  // mistyped key in an existing Kubernetes Secret) — not a deliberate choice.
  if (!secret && set(env, 'PUBLIC_BASE_URL')) {
    warnings.push(
      'PUBLIC_BASE_URL is set but MCP_SESSION_SECRET is not — OAuth is OFF.' +
        (envToken && !multiUser ? ' WIKIJS_TOKEN is set, so /mcp serves unauthenticated callers with that service key.' : ''),
    );
  }
  if (set(env, 'WIKIJS_KEY_MAP') && !set(env, 'WIKIJS_URL') && !set(env, 'WIKIJS_BASE_URL')) {
    warnings.push(
      'WIKIJS_KEY_MAP is set but WIKIJS_URL is not — its server keys are only sent to WIKIJS_URL, so the aliases cannot be used.',
    );
  }
  // Mirrors lib/caller-url.ts: any caller may name the wiki (SSRF surface, R-14b).
  if (!secret && pureByok(env)) {
    warnings.push(
      'reines BYOK — Aufrufer bestimmen das Ziel-Wiki (X-Wikijs-Url); interne Adressen werden abgelehnt, ' +
        'DNS-Rebinding ist aber nicht vollständig abgedeckt. WIKIJS_URL oder WIKIJS_ALLOWED_URLS setzen.',
    );
  }
  if (envToken && multiUser) {
    warnings.push(
      'WIKIJS_TOKEN is set together with WIKIJS_PROFILES/WIKIJS_KEY_MAP — it is NOT used for anonymous HTTP callers (multi-user mode).',
    );
  }

  const oauthRole = set(env, 'WIKIJS_OAUTH_ROLE');
  if (oauthRole && !ROLES[oauthRole]) {
    errors.push(`WIKIJS_OAUTH_ROLE "${oauthRole}" is not a known role (${knownRoles()}).`);
  }
}

/** Log warnings; throw one Error listing every problem if the config is invalid. */
export function assertConfig(
  env: Env = process.env,
  warn: (msg: string) => void = console.warn,
  opts: CheckOptions = {},
): void {
  const { errors, warnings } = checkConfig(env, opts);
  for (const w of warnings) warn(`[config] warning: ${w}`);
  if (errors.length > 0) {
    throw new Error(`Invalid server configuration:\n  - ${errors.join('\n  - ')}`);
  }
}
