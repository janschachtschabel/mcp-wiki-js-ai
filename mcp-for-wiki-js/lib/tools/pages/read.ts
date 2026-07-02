import { z } from 'zod';
import { ok, truncateContent } from '../../wikijs/format';
import type { ToolDef } from '../types';
import {
  assertPageIdNotBlocked,
  assertTagsNotBlocked,
  blockedPageSets,
  filterBlockedPages,
} from '../../guardrails';
import { DEFAULT_MAX_CONTENT, singleSelection } from './shared';

export const pageReadTools: ToolDef[] = [
  {
    name: 'wiki_pages_search',
    description: 'Full-text search for pages by query string, optionally scoped to a path prefix and locale.',
    category: 'read',
    inputSchema: {
      query: z.string().min(1).describe('Search query.'),
      path: z.string().optional().describe('Restrict to this path prefix.'),
      locale: z.string().optional().describe('Restrict to this locale (e.g. "en", "de").'),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($query:String!,$path:String,$locale:String){ pages { search(query:$query,path:$path,locale:$locale){ results { id title description path locale } suggestions totalHits } } }`,
        { query: a.query, path: a.path, locale: a.locale },
      );
      // Search results carry no tags — drop hits on blocked pages via id AND
      // path (search indexes can serve stale entries with outdated ids).
      const blocked = await blockedPageSets(ctx);
      if (blocked.ids.size > 0) {
        const results = (data.pages.search.results as { id: number | string; path?: string }[]).filter(
          (r) => !blocked.ids.has(Number(r.id)) && !blocked.paths.has((r.path ?? '').toLowerCase()),
        );
        const hidden = data.pages.search.results.length - results.length;
        return ok({ ...data.pages.search, results, ...(hidden > 0 ? { hiddenByTagGuardrail: hidden } : {}) });
      }
      return ok(data.pages.search);
    },
  },
  {
    name: 'wiki_page_get',
    description: 'Get a single page by numeric id OR by path+locale. Use metadataOnly to skip content.',
    category: 'read',
    inputSchema: {
      id: z.number().int().optional().describe('Page id (mutually exclusive with path).'),
      path: z.string().optional().describe('Page path, e.g. "docs/intro" (requires locale).'),
      locale: z.string().default('en').describe('Locale for path lookup. Default "en".'),
      metadataOnly: z.boolean().default(false).describe('If true, omit the page content/body.'),
      includeRender: z.boolean().default(false).describe('If true, also return the rendered HTML.'),
      maxContentChars: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(`Truncate content above this many chars (default ${DEFAULT_MAX_CONTENT}; 0 = unlimited).`),
    },
    handler: async (a, ctx) => {
      const selection = singleSelection(!a.metadataOnly, !!a.includeRender);
      const limit = a.maxContentChars ?? DEFAULT_MAX_CONTENT;
      if (a.id != null) {
        const data = await ctx.client.request(
          `query($id:Int!){ pages { single(id:$id){ ${selection} } } }`,
          { id: a.id },
        );
        if (data.pages.single) assertTagsNotBlocked(data.pages.single.tags, `Page ${a.id}`);
        return ok(truncateContent(data.pages.single, limit) ?? { error: `No page with id ${a.id}` });
      }
      if (a.path) {
        const data = await ctx.client.request(
          `query($path:String!,$locale:String!){ pages { singleByPath(path:$path,locale:$locale){ ${selection} } } }`,
          { path: a.path, locale: a.locale ?? 'en' },
        );
        if (data.pages.singleByPath) assertTagsNotBlocked(data.pages.singleByPath.tags, `Page ${a.path}`);
        return ok(
          truncateContent(data.pages.singleByPath, limit) ?? { error: `No page at ${a.path} (${a.locale ?? 'en'})` },
        );
      }
      throw new Error('Provide either "id" or "path".');
    },
  },
  {
    name: 'wiki_pages_list',
    description: 'List pages with optional filtering by locale/tags and ordering.',
    category: 'read',
    inputSchema: {
      limit: z.number().int().positive().optional().describe('Max number of pages.'),
      locale: z.string().optional(),
      tags: z.array(z.string()).optional().describe('Only pages carrying all of these tags.'),
      orderBy: z.enum(['CREATED', 'ID', 'PATH', 'TITLE', 'UPDATED']).default('TITLE'),
      orderByDirection: z.enum(['ASC', 'DESC']).default('ASC'),
      creatorId: z.number().int().optional(),
      authorId: z.number().int().optional(),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($limit:Int,$orderBy:PageOrderBy,$orderByDirection:PageOrderByDirection,$tags:[String!],$locale:String,$creatorId:Int,$authorId:Int){ pages { list(limit:$limit,orderBy:$orderBy,orderByDirection:$orderByDirection,tags:$tags,locale:$locale,creatorId:$creatorId,authorId:$authorId){ id path locale title description contentType isPublished isPrivate createdAt updatedAt tags } } }`,
        {
          limit: a.limit,
          orderBy: a.orderBy ?? 'TITLE',
          orderByDirection: a.orderByDirection ?? 'ASC',
          tags: a.tags,
          locale: a.locale,
          creatorId: a.creatorId,
          authorId: a.authorId,
        },
      );
      const { visible, hidden } = filterBlockedPages(data.pages.list as { tags?: unknown }[]);
      return ok(hidden > 0 ? { pages: visible, hiddenByTagGuardrail: hidden } : visible);
    },
  },
  {
    name: 'wiki_pages_tree',
    description: 'Get the hierarchical page/folder tree under a path or parent folder id.',
    category: 'read',
    inputSchema: {
      path: z.string().optional().describe('Folder path to list under (root = "").'),
      parent: z.number().int().optional().describe('Parent folder id (alternative to path).'),
      mode: z.enum(['FOLDERS', 'PAGES', 'ALL']).default('ALL'),
      locale: z.string().default('en'),
      includeAncestors: z.boolean().default(false),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($path:String,$parent:Int,$mode:PageTreeMode!,$locale:String!,$includeAncestors:Boolean){ pages { tree(path:$path,parent:$parent,mode:$mode,locale:$locale,includeAncestors:$includeAncestors){ id path depth title isPrivate isFolder privateNS parent pageId locale } } }`,
        {
          path: a.parent != null ? undefined : (a.path ?? ''),
          parent: a.parent,
          mode: a.mode ?? 'ALL',
          locale: a.locale ?? 'en',
          includeAncestors: !!a.includeAncestors,
        },
      );
      return ok(data.pages.tree);
    },
  },
  {
    name: 'wiki_page_history',
    description: 'Get the version/edit history trail of a page.',
    category: 'read',
    inputSchema: {
      id: z.number().int().describe('Page id.'),
      offsetPage: z.number().int().default(0),
      offsetSize: z.number().int().default(100),
    },
    handler: async (a, ctx) => {
      await assertPageIdNotBlocked(ctx, a.id, `Page ${a.id}`);
      const data = await ctx.client.request(
        `query($id:Int!,$offsetPage:Int,$offsetSize:Int){ pages { history(id:$id,offsetPage:$offsetPage,offsetSize:$offsetSize){ trail { versionId versionDate authorId authorName actionType valueBefore valueAfter } total } } }`,
        { id: a.id, offsetPage: a.offsetPage ?? 0, offsetSize: a.offsetSize ?? 100 },
      );
      return ok(data.pages.history);
    },
  },
  {
    name: 'wiki_page_version',
    description: 'Get the full content of one historical version of a page.',
    category: 'read',
    inputSchema: {
      pageId: z.number().int(),
      versionId: z.number().int(),
    },
    handler: async (a, ctx) => {
      // Guard against BOTH the current tags and the historical version's tags.
      await assertPageIdNotBlocked(ctx, a.pageId, `Page ${a.pageId}`);
      const data = await ctx.client.request(
        `query($pageId:Int!,$versionId:Int!){ pages { version(pageId:$pageId,versionId:$versionId){ versionId pageId path title description content contentType editor locale isPrivate isPublished tags action authorName versionDate createdAt } } }`,
        { pageId: a.pageId, versionId: a.versionId },
      );
      if (data.pages.version) assertTagsNotBlocked(data.pages.version.tags, `Page ${a.pageId}`);
      return ok(data.pages.version);
    },
  },
  {
    name: 'wiki_pages_links',
    description: 'List all internal links between pages for a locale (useful for finding broken links).',
    category: 'read',
    inputSchema: { locale: z.string().default('en') },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($locale:String!){ pages { links(locale:$locale){ id path title links } } }`,
        { locale: a.locale ?? 'en' },
      );
      return ok(data.pages.links);
    },
  },
  {
    name: 'wiki_tags_list',
    description: 'List all tags defined in the wiki.',
    category: 'read',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(
        `query{ pages { tags { id tag title createdAt updatedAt } } }`,
      );
      return ok(data.pages.tags);
    },
  },
  {
    name: 'wiki_tags_search',
    description: 'Suggest tags matching a partial query.',
    category: 'read',
    inputSchema: { query: z.string().min(1) },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(`query($query:String!){ pages { searchTags(query:$query) } }`, {
        query: a.query,
      });
      return ok(data.pages.searchTags);
    },
  },
];
