import { z } from 'zod';
import type { WikiContext } from '../../context';
import { ok, fail, assertOk, wildcardMatcher } from '../../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from '../types';
import { assertPageIdNotBlocked, assertTagIdNotBlocked, blockedPageIds } from '../../guardrails';
import { DELETE_PAGE, LIST_ALL_PATHS, requirePageId } from './shared';

/** Without force, one call deletes at most this many pages (audit R-06). */
export const MAX_DELETE_WITHOUT_FORCE = 50;
/** Paths listed in a preview / refusal; the count is always exact. */
const LISTED_TARGETS = 100;
/** Longest accepted pathPattern — matching cost must stay small per page (review 2026-10-21 #1). */
const MAX_PATH_PATTERN = 512;

interface Target {
  id: number;
  path: string;
  locale: string;
}

interface Resolved {
  targets: Target[];
  skippedBlocked: number;
  notFound: string[];
}

const label = (t: Target) => `${t.locale}/${t.path}`;
const normalizePath = (p: string) => p.replace(/^\/+|\/+$/g, '');

/** All pages visible to the caller; `locale` undefined = every locale. */
async function listPages(ctx: WikiContext, locale?: string): Promise<Target[]> {
  const data = await ctx.client.request<{ pages: { list: Target[] } }>(LIST_ALL_PATHS, { locale });
  return data.pages.list;
}

/** Drop pages carrying a blocked tag — from a FRESH lookup, never the read cache (audit R-27). */
async function withoutBlocked(ctx: WikiContext, found: Target[]): Promise<{ targets: Target[]; skippedBlocked: number }> {
  const blocked = await blockedPageIds(ctx, { fresh: true });
  const targets = found.filter((t) => !blocked.has(t.id));
  return { targets, skippedBlocked: found.length - targets.length };
}

/** ids (any locale), paths and pathPattern (both in `locale`) → the pages a batch delete would hit. */
async function resolveBatchTargets(a: any, ctx: WikiContext): Promise<Resolved> {
  const locale: string = a.locale ?? 'en';
  const ids: number[] = a.ids ?? [];
  const paths: string[] = a.paths ?? [];
  const all = ids.length > 0 || paths.length > 0 || a.pathPattern ? await listPages(ctx) : [];
  const found = new Map<number, Target>();
  const notFound: string[] = [];
  for (const id of ids) {
    const page = all.find((p) => p.id === id);
    if (page) found.set(id, page);
    else notFound.push(`#${id}`);
  }
  for (const raw of paths) {
    const path = normalizePath(raw);
    const page = all.find((p) => p.path === path && p.locale === locale);
    if (page) found.set(page.id, page);
    else notFound.push(raw);
  }
  if (a.pathPattern) {
    const matches = wildcardMatcher(normalizePath(a.pathPattern));
    for (const p of all) if (p.locale === locale && matches(p.path)) found.set(p.id, p);
  }
  return { ...(await withoutBlocked(ctx, [...found.values()])), notFound };
}

/** rootPath + mode in `locale` → the pages a tree delete would hit, deepest first. */
async function resolveTreeTargets(a: any, ctx: WikiContext): Promise<Resolved> {
  const root = normalizePath(String(a.rootPath));
  const mode = a.mode ?? 'children_only';
  const locale: string = a.locale ?? 'en';
  let found = (await listPages(ctx, locale)).filter(
    (p) => p.locale === locale && (p.path === root || p.path.startsWith(`${root}/`)),
  );
  if (mode === 'children_only') found = found.filter((p) => p.path !== root);
  else if (mode === 'root_only') found = found.filter((p) => p.path === root);
  const { targets, skippedBlocked } = await withoutBlocked(ctx, found);
  // delete deepest paths first to avoid dependency issues
  targets.sort((x, y) => y.path.split('/').length - x.path.split('/').length);
  return { targets, skippedBlocked, notFound: [] };
}

function listed(r: Resolved): Record<string, unknown> {
  const more = r.targets.length - LISTED_TARGETS;
  return {
    count: r.targets.length,
    targets: r.targets.slice(0, LISTED_TARGETS).map(label),
    ...(more > 0 ? { moreNotListed: more } : {}),
    ...(r.skippedBlocked > 0 ? { skippedBlocked: r.skippedBlocked } : {}),
    ...(r.notFound.length > 0 ? { notFound: r.notFound } : {}),
  };
}

/** What the confirm dry-run shows: the real targets, not just the arguments. */
function preview(r: Resolved, force: unknown): Record<string, unknown> {
  return {
    ...listed(r),
    ...(r.targets.length > MAX_DELETE_WITHOUT_FORCE && force !== true
      ? { note: `More than ${MAX_DELETE_WITHOUT_FORCE} pages: the call will be refused unless "force": true.` }
      : {}),
    hint: `Targets are resolved again on execution. Pass "expectedCount": ${r.targets.length} with "confirm": true to refuse if the set has changed.`,
  };
}

/** Delete the resolved pages one by one (refused above the cap unless forced), reporting per page. */
async function deleteTargets(
  ctx: WikiContext,
  r: Resolved,
  a: { force?: unknown; expectedCount?: number },
  extra: Record<string, unknown> = {},
) {
  // Preview and execution resolve independently; pages added in between must not be deleted unseen (#3).
  if (a.expectedCount !== undefined && r.targets.length !== a.expectedCount) {
    return fail(
      `Refusing to delete: the selection now resolves to ${r.targets.length} pages, but expectedCount is ${a.expectedCount}. ` +
        `Nothing was deleted. Review the current targets and repeat with the new count.\n\n` +
        JSON.stringify({ ...extra, ...listed(r) }, null, 2),
    );
  }
  if (r.targets.length > MAX_DELETE_WITHOUT_FORCE && a.force !== true) {
    return fail(
      `Refusing to delete ${r.targets.length} pages in one call (limit ${MAX_DELETE_WITHOUT_FORCE} without "force": true). ` +
        `Nothing was deleted. Check the targets, then repeat with "force": true or narrow the selection.\n\n` +
        JSON.stringify({ ...extra, ...listed(r) }, null, 2),
    );
  }
  if (r.targets.length === 0) {
    return ok({ ...extra, deleted: 0, results: [], ...listed(r), message: 'No matching (unblocked) pages found.' });
  }
  const results: { id: number; path: string; deleted: boolean; error?: string }[] = [];
  for (const t of r.targets) {
    try {
      const data = await ctx.client.request(DELETE_PAGE, { id: t.id });
      assertOk(data.pages.delete.responseResult, `Delete page ${t.id}`);
      results.push({ id: t.id, path: label(t), deleted: true });
    } catch (e) {
      results.push({ id: t.id, path: label(t), deleted: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return ok({
    ...extra,
    total: r.targets.length,
    deleted: results.filter((x) => x.deleted).length,
    ...(r.skippedBlocked > 0 ? { skippedBlocked: r.skippedBlocked } : {}),
    ...(r.notFound.length > 0 ? { notFound: r.notFound } : {}),
    results,
  });
}

const forceField = z
  .boolean()
  .default(false)
  .describe(`Required to delete more than ${MAX_DELETE_WITHOUT_FORCE} pages in one call.`);
const expectedCountField = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('The target count from the preview. If the selection resolves to a different count, nothing is deleted.');
const EXPECTED_COUNT_HINT =
  ' Targets are resolved again on execution; pass expectedCount (the previewed count) to refuse if the set has changed.';

export const pageDeleteTools: ToolDef[] = [
  {
    name: 'wiki_page_delete',
    description: 'Permanently delete a single page, identified by id OR path+locale.',
    category: 'delete',
    inputSchema: {
      id: z.number().int().optional().describe('Page id (or use path+locale).'),
      path: z.string().optional().describe('Page path (alternative to id).'),
      locale: z.string().default('en').describe('Locale for path lookup.'),
    },
    handler: async (a, ctx) => {
      const id = await requirePageId(ctx, a);
      await assertPageIdNotBlocked(ctx, id, `Page ${id}`);
      const data = await ctx.client.request(DELETE_PAGE, { id });
      assertOk(data.pages.delete.responseResult, 'Delete page');
      return ok({ id }, '🗑️ Page deleted.');
    },
  },
  {
    name: 'wiki_pages_delete_batch',
    description:
      'Delete multiple pages by ids, by paths, and/or by a wildcard path pattern in one locale. Pattern: "*" and "?" ' +
      'stay within one path segment, "**" spans any depth (e.g. "drafts/*" = direct children, "drafts/**" = everything ' +
      `below). More than ${MAX_DELETE_WITHOUT_FORCE} pages need force=true. Returns a per-page result; ids/paths that ` +
      'match no page are listed as notFound.' +
      EXPECTED_COUNT_HINT,
    category: 'delete',
    inputSchema: {
      ids: z.array(z.number().int()).optional(),
      paths: z.array(z.string()).optional(),
      pathPattern: z
        .string()
        .max(MAX_PATH_PATTERN)
        .optional()
        .describe('Wildcard against page paths: "*", "?" (one segment), "**" (any depth).'),
      locale: z.string().default('en').describe('Locale for "paths" and "pathPattern" (ids are locale-independent).'),
      force: forceField,
      expectedCount: expectedCountField,
    },
    preview: async (a, ctx) => preview(await resolveBatchTargets(a, ctx), a.force),
    handler: async (a, ctx) => deleteTargets(ctx, await resolveBatchTargets(a, ctx), a),
  },
  {
    name: 'wiki_pages_delete_tree',
    description:
      'Delete a page subtree under rootPath in one locale. mode: "children_only" (keep root), "include_root" ' +
      `(root + descendants), "root_only". More than ${MAX_DELETE_WITHOUT_FORCE} pages need force=true.` +
      EXPECTED_COUNT_HINT,
    category: 'delete',
    inputSchema: {
      rootPath: z.string().min(1),
      mode: z.enum(['children_only', 'include_root', 'root_only']).default('children_only'),
      locale: z.string().default('en').describe('Locale of the subtree.'),
      force: forceField,
      expectedCount: expectedCountField,
    },
    preview: async (a, ctx) => preview(await resolveTreeTargets(a, ctx), a.force),
    handler: async (a, ctx) =>
      deleteTargets(ctx, await resolveTreeTargets(a, ctx), a, {
        root: normalizePath(String(a.rootPath)),
        mode: a.mode ?? 'children_only',
      }),
  },
  {
    name: 'wiki_tag_delete',
    description: 'Delete a tag by id.',
    category: 'delete',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx) => {
      // Deleting a guardrail tag would un-block every page carrying it.
      await assertTagIdNotBlocked(ctx, a.id, 'Tag delete');
      const data = await ctx.client.request(
        `mutation($id:Int!){ pages { deleteTag(id:$id){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id },
      );
      assertOk(data.pages.deleteTag.responseResult, 'Delete tag');
      return ok({ id: a.id }, '🗑️ Tag deleted.');
    },
  },
  {
    name: 'wiki_pages_purge_history',
    description: 'Purge page version history older than a duration (e.g. "P1M", "P30D", or "1w").',
    category: 'delete',
    inputSchema: { olderThan: z.string().describe('ISO-8601 duration or relative spec accepted by Wiki.js.') },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($olderThan:String!){ pages { purgeHistory(olderThan:$olderThan){ ${DEFAULT_RESPONSE} } } }`,
        { olderThan: a.olderThan },
      );
      assertOk(data.pages.purgeHistory.responseResult, 'Purge history');
      return ok({ olderThan: a.olderThan }, '🗑️ History purged.');
    },
  },
];
