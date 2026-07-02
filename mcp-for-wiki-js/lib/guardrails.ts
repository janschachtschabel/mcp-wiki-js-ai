/**
 * Tag-based "no AI" guardrail.
 *
 * Wiki.js' own page-rules enforce PATH-based deny reliably, but its TAG rules
 * leak through pages.list / pages.single (the resolvers don't pass tags to
 * checkAccess). This module closes that hole AT THE MCP LAYER: pages carrying
 * a blocked tag (WIKIJS_BLOCKED_TAGS, e.g. "kein-ki") are hidden from reads
 * and refused for writes/deletes — for every credential type.
 *
 * Defense-in-depth, not a substitute: for hard guarantees against ANY API
 * consumer, additionally put sensitive content under a path with a Wiki.js
 * deny page-rule. Structure listings (tree/links) and comments are not
 * tag-filtered — documented limitation.
 *
 * Opt-in: without WIKIJS_BLOCKED_TAGS the guardrail is off and adds zero
 * upstream queries.
 */

import type { WikiContext } from './context';

/** Parse WIKIJS_BLOCKED_TAGS (comma-separated, case-insensitive). */
export function blockedTags(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = env.WIKIJS_BLOCKED_TAGS ?? '';
  return new Set(
    raw
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Accepts both tag shapes Wiki.js returns: ["a","b"] and [{tag:"a"},…]. */
export function extractTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === 'string' ? t : t && typeof t === 'object' && 'tag' in t ? String((t as { tag: unknown }).tag) : ''))
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

export function tagsBlocked(tags: unknown, blocked: Set<string> = blockedTags()): boolean {
  if (blocked.size === 0) return false;
  return extractTags(tags).some((t) => blocked.has(t));
}

/** Throw the uniform refusal for a blocked page (read AND write paths). */
export function assertTagsNotBlocked(tags: unknown, what: string): void {
  if (tagsBlocked(tags)) {
    throw new Error(`${what} is not available to AI agents (carries a blocked tag — see WIKIJS_BLOCKED_TAGS).`);
  }
}

/** Filter a page list; report how many were hidden so truncation is never silent. */
export function filterBlockedPages<T extends { tags?: unknown }>(pages: T[]): { visible: T[]; hidden: number } {
  const blocked = blockedTags();
  if (blocked.size === 0) return { visible: pages, hidden: 0 };
  const visible = pages.filter((p) => !tagsBlocked(p.tags, blocked));
  return { visible, hidden: pages.length - visible.length };
}

// ---------------------------------------------------------------------------
// Blocked-id set for responses that carry NO tags (search results, batch ops).
// One pages.list(tags:[t]) query per blocked tag, cached briefly PER CREDENTIAL:
// the upstream list is permission-filtered by the caller's own token, so a
// shared cache could leak blocked pages between users with different rights.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

export interface BlockedPageSets {
  ids: Set<number>;
  /** Lowercased page paths. Search indexes can serve STALE entries (e.g. after
   *  a locale migration Wiki.js does not reindex), so id-only filtering would
   *  leak title/path of a blocked page under an outdated id — paths close that. */
  paths: Set<string>;
}

const cache = new Map<string, { at: number; sets: BlockedPageSets }>();

function cacheKey(ctx: WikiContext): string {
  return `${ctx.baseUrl}|${ctx.credentialKey ?? 'anon'}`;
}

export async function blockedPageSets(ctx: WikiContext): Promise<BlockedPageSets> {
  const blocked = blockedTags();
  if (blocked.size === 0) return { ids: new Set(), paths: new Set() };
  const key = cacheKey(ctx);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.sets;

  const sets: BlockedPageSets = { ids: new Set(), paths: new Set() };
  for (const tag of blocked) {
    const data = await ctx.client.request<{ pages: { list: { id: number; path: string }[] } }>(
      `query($tags:[String!]){ pages { list(tags:$tags) { id path } } }`,
      { tags: [tag] },
    );
    for (const p of data.pages.list) {
      sets.ids.add(p.id);
      sets.paths.add(p.path.toLowerCase());
    }
  }
  // Bounded: entries expire after TTL; drop stale ones so many credentials can't grow the map.
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
  }
  cache.set(key, { at: Date.now(), sets });
  return sets;
}

/** Convenience for callers that only act on real DB rows (deletes). */
export async function blockedPageIds(ctx: WikiContext): Promise<Set<number>> {
  return (await blockedPageSets(ctx)).ids;
}

/**
 * Protect the guardrail itself: renaming or deleting a blocked tag would
 * silently un-block every page carrying it.
 */
export async function assertTagIdNotBlocked(ctx: WikiContext, id: number, action: string): Promise<void> {
  const blocked = blockedTags();
  if (blocked.size === 0) return;
  const data = await ctx.client.request<{ pages: { tags: { id: number; tag: string }[] } }>(
    'query { pages { tags { id tag } } }',
  );
  const tag = data.pages.tags.find((t) => t.id === id);
  if (tag && blocked.has(tag.tag.toLowerCase())) {
    throw new Error(
      `${action} refused: "${tag.tag}" is a protected AI-guardrail tag (WIKIJS_BLOCKED_TAGS) and must be managed by a human in the wiki UI.`,
    );
  }
}

/** For tools that only have a page id: fetch the tags, then assert. */
export async function assertPageIdNotBlocked(ctx: WikiContext, id: number, what: string): Promise<void> {
  if (blockedTags().size === 0) return;
  const data = await ctx.client.request<{ pages: { single: { tags: { tag: string }[] } | null } }>(
    `query($id:Int!){ pages { single(id:$id){ tags { tag } } } }`,
    { id },
  );
  assertTagsNotBlocked(data.pages.single?.tags, what || `Page ${id}`);
}

/** Test hook. */
export function clearBlockedIdCache(): void {
  cache.clear();
}
