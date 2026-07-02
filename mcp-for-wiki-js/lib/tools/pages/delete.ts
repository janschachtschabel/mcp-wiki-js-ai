import { z } from 'zod';
import { ok, assertOk, wildcardToRegExp } from '../../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from '../types';
import { assertPageIdNotBlocked, assertTagIdNotBlocked, blockedPageIds } from '../../guardrails';
import { DELETE_PAGE, LIST_ALL_PATHS, requirePageId, resolvePathToId } from './shared';

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
      'Delete multiple pages by ids, by paths, and/or by a wildcard path pattern (e.g. "drafts/*"). Returns a per-page result.',
    category: 'delete',
    inputSchema: {
      ids: z.array(z.number().int()).optional(),
      paths: z.array(z.string()).optional(),
      pathPattern: z.string().optional().describe('Shell-style wildcard against page paths, e.g. "tmp/*".'),
      locale: z.string().default('en').describe('Locale used when resolving "paths".'),
    },
    handler: async (a, ctx) => {
      const ids = new Set<number>();
      (a.ids ?? []).forEach((i: number) => ids.add(i));
      for (const p of a.paths ?? []) {
        const pid = await resolvePathToId(ctx, p, a.locale ?? 'en');
        if (pid) ids.add(pid);
      }
      if (a.pathPattern) {
        const all = await ctx.client.request<{ pages: { list: { id: number; path: string }[] } }>(LIST_ALL_PATHS, {});
        const rx = wildcardToRegExp(a.pathPattern);
        for (const pg of all.pages.list) if (rx.test(pg.path)) ids.add(pg.id);
      }
      // Pages carrying a blocked tag are skipped, not deleted (and reported).
      const blocked = await blockedPageIds(ctx);
      const targets = [...ids].filter((id) => !blocked.has(id));
      const skippedBlocked = ids.size - targets.length;
      if (targets.length === 0) {
        return ok({ deleted: 0, results: [], skippedBlocked, message: 'No matching (unblocked) pages found.' });
      }
      const results: { id: number; deleted: boolean; error?: string }[] = [];
      for (const id of targets) {
        try {
          const data = await ctx.client.request(DELETE_PAGE, { id });
          assertOk(data.pages.delete.responseResult, `Delete page ${id}`);
          results.push({ id, deleted: true });
        } catch (e) {
          results.push({ id, deleted: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return ok({
        total: targets.length,
        deleted: results.filter((r) => r.deleted).length,
        ...(skippedBlocked > 0 ? { skippedBlocked } : {}),
        results,
      });
    },
  },
  {
    name: 'wiki_pages_delete_tree',
    description:
      'Delete a page subtree under rootPath. mode: "children_only" (keep root), "include_root" (root + descendants), "root_only".',
    category: 'delete',
    inputSchema: {
      rootPath: z.string().min(1),
      mode: z.enum(['children_only', 'include_root', 'root_only']).default('children_only'),
    },
    handler: async (a, ctx) => {
      const root = String(a.rootPath).replace(/\/+$/, '');
      const all = await ctx.client.request<{ pages: { list: { id: number; path: string }[] } }>(LIST_ALL_PATHS, {});
      let targets = all.pages.list.filter((p) => p.path === root || p.path.startsWith(`${root}/`));
      const mode = a.mode ?? 'children_only';
      if (mode === 'children_only') targets = targets.filter((p) => p.path !== root);
      else if (mode === 'root_only') targets = targets.filter((p) => p.path === root);
      const blocked = await blockedPageIds(ctx);
      const beforeGuardrail = targets.length;
      targets = targets.filter((p) => !blocked.has(p.id));
      const skippedBlocked = beforeGuardrail - targets.length;
      // delete deepest paths first to avoid dependency issues
      targets.sort((x, y) => y.path.split('/').length - x.path.split('/').length);
      const results: { id: number; path: string; deleted: boolean; error?: string }[] = [];
      for (const pg of targets) {
        try {
          const data = await ctx.client.request(DELETE_PAGE, { id: pg.id });
          assertOk(data.pages.delete.responseResult, `Delete page ${pg.id}`);
          results.push({ id: pg.id, path: pg.path, deleted: true });
        } catch (e) {
          results.push({ id: pg.id, path: pg.path, deleted: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return ok({
        root,
        mode,
        total: targets.length,
        deleted: results.filter((r) => r.deleted).length,
        ...(skippedBlocked > 0 ? { skippedBlocked } : {}),
        results,
      });
    },
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
