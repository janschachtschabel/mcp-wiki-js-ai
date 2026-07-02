/**
 * Permission policy engine.
 *
 * Every tool declares a `category`. The policy maps each category (and optionally
 * each individual tool) to a mode:
 *   - allow   : run immediately
 *   - confirm : return a dry-run preview unless the caller passed confirm=true
 *   - block   : hidden from tools/list (or refuses to run)
 *
 * A deployment sets a BASELINE policy via env (preset + JSON overrides). Untrusted
 * per-request overlays (HTTP headers) may only ever make access STRICTER, never
 * looser — so a user can downgrade themselves to read-only but can never unlock a
 * tool the server operator blocked.
 */

import rolesConfig from '../config/roles.json';

export const CATEGORIES = [
  'read',
  'write',
  'delete',
  'manage_users',
  'manage_groups',
  'manage_system',
  'manage_auth',
] as const;

export type Category = (typeof CATEGORIES)[number];
export type PolicyMode = 'allow' | 'confirm' | 'block';

const RANK: Record<PolicyMode, number> = { allow: 0, confirm: 1, block: 2 };

/** The stricter (higher-ranked) of two modes. */
export function strictest(a: PolicyMode, b: PolicyMode): PolicyMode {
  return RANK[a] >= RANK[b] ? a : b;
}

export type CategoryMap = Record<Category, PolicyMode>;

function cat(
  read: PolicyMode,
  write: PolicyMode,
  del: PolicyMode,
  users: PolicyMode,
  groups: PolicyMode,
  system: PolicyMode,
  auth: PolicyMode,
): CategoryMap {
  return {
    read,
    write,
    delete: del,
    manage_users: users,
    manage_groups: groups,
    manage_system: system,
    manage_auth: auth,
  };
}

const VALID_MODES = new Set<PolicyMode>(['allow', 'confirm', 'block']);
const VALID_CATEGORIES = new Set<string>(CATEGORIES);

/** A fully-resolved role: a complete category map plus optional per-tool overrides. */
export interface RoleDef {
  categories: CategoryMap;
  tools: Record<string, PolicyMode>;
}

/** Raw role as it appears in config, before `extends` resolution. */
interface RawRole {
  extends?: string;
  categories?: Record<string, unknown>;
  tools?: Record<string, unknown>;
}

const ALL_BLOCK: CategoryMap = cat('block', 'block', 'block', 'block', 'block', 'block', 'block');

/** Minimal built-in roles (fallback if config/roles.json is missing/invalid). */
const BUILTIN_RAW_ROLES: Record<string, RawRole> = {
  readonly: { categories: { read: 'allow' } },
  safe: { categories: { read: 'allow', write: 'confirm', delete: 'confirm' } },
  editor: { extends: 'readonly', categories: { write: 'allow', delete: 'confirm' } },
  maintainer: {
    extends: 'editor',
    categories: { manage_users: 'confirm', manage_groups: 'confirm', manage_system: 'confirm', manage_auth: 'confirm' },
  },
  full: {
    categories: {
      read: 'allow', write: 'allow', delete: 'allow',
      manage_users: 'allow', manage_groups: 'allow', manage_system: 'allow', manage_auth: 'allow',
    },
  },
};

/** Resolve a raw role (following `extends`) into a full RoleDef. Cycle-safe. */
function resolveRole(
  name: string,
  raw: Record<string, RawRole>,
  cache: Record<string, RoleDef>,
  stack: Set<string>,
): RoleDef {
  if (cache[name]) return cache[name];
  const def = raw[name];
  if (!def || stack.has(name)) return { categories: { ...ALL_BLOCK }, tools: {} };
  stack.add(name);
  const parent: RoleDef =
    def.extends && raw[def.extends]
      ? resolveRole(def.extends, raw, cache, stack)
      : { categories: { ...ALL_BLOCK }, tools: {} };
  stack.delete(name);
  const resolved: RoleDef = {
    categories: { ...parent.categories, ...sanitizeCategories(def.categories) },
    tools: { ...parent.tools, ...sanitizeTools(def.tools) },
  };
  cache[name] = resolved;
  return resolved;
}

/** Load roles: built-ins ← config/roles.json (bundled at build) ← WIKIJS_ROLES env (runtime override). */
function loadRoles(): { roles: Record<string, RoleDef>; defaultRole: string } {
  const raw: Record<string, RawRole> = { ...BUILTIN_RAW_ROLES };
  let defaultRole = 'safe';

  const sources: unknown[] = [rolesConfig];
  if (process.env.WIKIJS_ROLES) {
    try {
      sources.push(JSON.parse(process.env.WIKIJS_ROLES));
    } catch {
      /* ignore malformed WIKIJS_ROLES */
    }
  }
  for (const src of sources) {
    const cfg = src as { roles?: Record<string, RawRole>; defaultRole?: unknown } | null | undefined;
    if (cfg && typeof cfg === 'object' && cfg.roles && typeof cfg.roles === 'object') {
      for (const [n, d] of Object.entries(cfg.roles)) raw[n] = d as RawRole;
    }
    if (cfg && typeof cfg === 'object' && typeof cfg.defaultRole === 'string') defaultRole = cfg.defaultRole;
  }

  const roles: Record<string, RoleDef> = {};
  for (const n of Object.keys(raw)) roles[n] = resolveRole(n, raw, roles, new Set());
  if (!roles[defaultRole]) defaultRole = roles.safe ? 'safe' : (Object.keys(roles)[0] ?? 'safe');
  return { roles, defaultRole };
}

const LOADED = loadRoles();

/** Fully-resolved roles (built-ins ← config/roles.json ← WIKIJS_ROLES env). */
export const ROLES: Record<string, RoleDef> = LOADED.roles;

/** Category-level view of each role — used for the global ceiling and parsePolicyConfig. */
export const PRESETS: Record<string, CategoryMap> = Object.fromEntries(
  Object.entries(ROLES).map(([n, r]) => [n, r.categories]),
) as Record<string, CategoryMap>;

/** The default/ceiling role name (used for the global ceiling and entries without a role). */
export const DEFAULT_PRESET = LOADED.defaultRole;

/** A role expressed as a tighten-only PolicyConfig overlay (categories + per-tool). */
export function roleConfig(name: string | undefined): PolicyConfig | undefined {
  if (!name) return undefined;
  const r = ROLES[name];
  if (!r) return undefined;
  return { categories: { ...r.categories }, tools: { ...r.tools } };
}

export interface PolicyConfig {
  preset?: string;
  categories?: Partial<CategoryMap>;
  tools?: Record<string, PolicyMode>;
}

function sanitizeCategories(input: unknown): Partial<CategoryMap> {
  const out: Partial<CategoryMap> = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (VALID_CATEGORIES.has(k) && typeof v === 'string' && VALID_MODES.has(v as PolicyMode)) {
        out[k as Category] = v as PolicyMode;
      }
    }
  }
  return out;
}

function sanitizeTools(input: unknown): Record<string, PolicyMode> {
  const out: Record<string, PolicyMode> = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === 'string' && VALID_MODES.has(v as PolicyMode)) out[k] = v as PolicyMode;
    }
  }
  return out;
}

export function parsePolicyConfig(raw: unknown): PolicyConfig | undefined {
  let obj: any = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return undefined;
    try {
      obj = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const config: PolicyConfig = {
    preset: typeof obj.preset === 'string' && PRESETS[obj.preset] ? obj.preset : undefined,
    categories: sanitizeCategories(obj.categories),
    tools: sanitizeTools(obj.tools),
  };
  return config;
}

export class Policy {
  constructor(
    private readonly base: CategoryMap,
    private readonly cats: Partial<CategoryMap>,
    private readonly tools: Record<string, PolicyMode>,
    readonly showBlocked: boolean,
    private readonly overlays: readonly PolicyConfig[] = [],
  ) {}

  /**
   * Return a copy carrying an additional overlay. Overlays stack and can only ever
   * TIGHTEN (a per-profile preset and a per-request preset both apply, strictest wins).
   */
  withOverlay(overlay?: PolicyConfig): Policy {
    if (!overlay) return this;
    return new Policy(this.base, this.cats, this.tools, this.showBlocked, [...this.overlays, overlay]);
  }

  /** Resolve the effective mode for a tool in a given category. */
  resolve(toolName: string, category: Category): PolicyMode {
    let mode: PolicyMode = this.tools[toolName] ?? this.cats[category] ?? this.base[category];
    for (const overlay of this.overlays) {
      const presetMap = overlay.preset ? PRESETS[overlay.preset] : undefined;
      const ov = overlay.tools?.[toolName] ?? overlay.categories?.[category] ?? presetMap?.[category];
      if (ov) mode = strictest(mode, ov);
    }
    return mode;
  }
}

/** Build the deployment-wide baseline policy from environment variables. */
export function basePolicyFromEnv(env: Record<string, string | undefined> = process.env): Policy {
  const presetName = (env.WIKIJS_PERMISSION_PRESET || DEFAULT_PRESET).toLowerCase();
  const base = PRESETS[presetName] ?? PRESETS[DEFAULT_PRESET];
  const override = parsePolicyConfig(env.WIKIJS_POLICY);
  const cats = override?.categories ?? {};
  const tools = override?.tools ?? {};
  const showBlocked = /^(1|true|yes|on)$/i.test(env.WIKIJS_SHOW_BLOCKED || '');
  return new Policy(base, cats, tools, showBlocked);
}
