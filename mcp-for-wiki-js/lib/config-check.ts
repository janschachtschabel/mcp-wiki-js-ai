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

export function checkConfig(env: Env = process.env): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];

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

  const preset = set(env, 'WIKIJS_PERMISSION_PRESET');
  if (preset && !PRESETS[preset.toLowerCase()]) {
    errors.push(`WIKIJS_PERMISSION_PRESET "${preset}" is not a known role (${knownRoles()}).`);
  }
  const oauthRole = set(env, 'WIKIJS_OAUTH_ROLE');
  if (oauthRole && !ROLES[oauthRole]) {
    errors.push(`WIKIJS_OAUTH_ROLE "${oauthRole}" is not a known role (${knownRoles()}).`);
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

/** Log warnings; throw one Error listing every problem if the config is invalid. */
export function assertConfig(env: Env = process.env, warn: (msg: string) => void = console.warn): void {
  const { errors, warnings } = checkConfig(env);
  for (const w of warnings) warn(`[config] warning: ${w}`);
  if (errors.length > 0) {
    throw new Error(`Invalid server configuration:\n  - ${errors.join('\n  - ')}`);
  }
}
