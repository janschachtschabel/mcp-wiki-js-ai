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
 * deny page-rule. Structure listings (tree/links) are filtered by the blocked
 * id/path set. Comments are checked where the page is known (list by path,
 * create by pageId); a comment addressed only by its own id cannot be mapped
 * to its page via GraphQL — documented limitation.
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

/** A guardrail refusal — a policy decision, audited as "blocked" rather than "error". */
export class GuardrailError extends Error {}

/** Throw the uniform refusal for a blocked page (read AND write paths). */
function blockedPageError(what: string): GuardrailError {
  return new GuardrailError(`${what} is not available to AI agents (carries a blocked tag — see WIKIJS_BLOCKED_TAGS).`);
}

export function assertTagsNotBlocked(tags: unknown, what: string): void {
  if (tagsBlocked(tags)) throw blockedPageError(what);
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
  /** Page paths as {@link blockedPathKey}. Search indexes can serve STALE entries (e.g. after
   *  a locale migration Wiki.js does not reindex), so id-only filtering would
   *  leak title/path of a blocked page under an outdated id — paths close that. */
  paths: Set<string>;
  /** The blocked pages themselves (path + locale), e.g. to list their comments. */
  pages: { path: string; locale: string }[];
}

/**
 * Comparison key for blocked paths. Wiki.js looks pages up by path in the DB, and
 * MySQL/MariaDB/MSSQL collations ignore case, accents and trailing spaces — so
 * "intern/gehéim " finds "intern/geheim" there. Folding the same way on BOTH sides
 * can only over-block, never leak (review 2026-10-21 #4).
 */
export function blockedPathKey(path: string): string {
  return path
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

const cache = new Map<string, { at: number; sets: BlockedPageSets }>();

function cacheKey(ctx: WikiContext): string {
  return `${ctx.baseUrl}|${ctx.credentialKey ?? 'anon'}`;
}

/**
 * `fresh: true` bypasses (and refreshes) the cache — for destructive callers,
 * where a page tagged within the last TTL must still be protected (audit R-27).
 */
export async function blockedPageSets(ctx: WikiContext, opts: { fresh?: boolean } = {}): Promise<BlockedPageSets> {
  const blocked = blockedTags();
  if (blocked.size === 0) return { ids: new Set(), paths: new Set(), pages: [] };
  const key = cacheKey(ctx);
  const cached = cache.get(key);
  if (!opts.fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.sets;

  const sets: BlockedPageSets = { ids: new Set(), paths: new Set(), pages: [] };
  for (const tag of blocked) {
    const data = await ctx.client.request<{ pages: { list: { id: number; path: string; locale: string }[] } }>(
      `query($tags:[String!]){ pages { list(tags:$tags) { id path locale } } }`,
      { tags: [tag] },
    );
    for (const p of data.pages.list) {
      if (!sets.ids.has(p.id)) sets.pages.push({ path: p.path, locale: p.locale });
      sets.ids.add(p.id);
      sets.paths.add(blockedPathKey(p.path));
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
export async function blockedPageIds(ctx: WikiContext, opts: { fresh?: boolean } = {}): Promise<Set<number>> {
  return (await blockedPageSets(ctx, opts)).ids;
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
    throw new GuardrailError(
      `${action} refused: "${tag.tag}" is a protected AI-guardrail tag (WIKIJS_BLOCKED_TAGS) and must be managed by a human in the wiki UI.`,
    );
  }
}

/**
 * For tools that only have a page id. Checks the blocked id set (pages.list, read:pages)
 * instead of the page's own tags via pages.single, which Wiki.js only answers with
 * manage:pages (audit A-01). Always fresh: the callers act on the page right away (R-27).
 * Limitation: pages.list only shows pages the caller may READ, so a page-rule set that
 * grants e.g. delete:pages or read:history while denying read:pages on the same path
 * lets that page pass this check — Wiki.js page rules remain the hard boundary.
 */
export async function assertPageIdNotBlocked(ctx: WikiContext, id: number, what: string): Promise<void> {
  if (blockedTags().size === 0) return;
  const sets = await blockedPageSets(ctx, { fresh: true });
  if (sets.ids.has(id)) throw blockedPageError(what || `Page ${id}`);
}

/**
 * Check a page against the blocked id/path set. Only needs read:pages (via
 * pages.list), unlike pages.single/singleByPath which require manage:pages —
 * so it also works for readers/commenters.
 */
export async function assertNotInBlockedSet(ctx: WikiContext, page: { id?: number; path?: string }, what: string): Promise<void> {
  if (blockedTags().size === 0) return;
  const sets = await blockedPageSets(ctx);
  if ((page.id != null && sets.ids.has(page.id)) || (page.path != null && sets.paths.has(blockedPathKey(page.path)))) {
    throw blockedPageError(what);
  }
}

/**
 * For comment tools that only have a comment id: CommentPost carries no pageId, so
 * the comments of every blocked page are listed and the id looked up (audit A-23).
 * Always fresh. Fails closed — an error listing a blocked page's comments propagates.
 */
export async function assertCommentNotBlocked(ctx: WikiContext, commentId: number, what: string): Promise<void> {
  if (blockedTags().size === 0) return;
  const { pages } = await blockedPageSets(ctx, { fresh: true });
  const lists = await Promise.all(
    pages.map((p) =>
      ctx.client.request<{ comments: { list: { id: number }[] } }>(
        `query($locale:String!,$path:String!){ comments { list(locale:$locale,path:$path){ id } } }`,
        { locale: p.locale, path: p.path },
      ),
    ),
  );
  if (lists.some((l) => l.comments.list.some((c) => c.id === commentId))) throw blockedPageError(what);
}

/** Test hook. */
export function clearBlockedIdCache(): void {
  cache.clear();
}
