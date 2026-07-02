import { z } from 'zod';
import { ok, assertOk } from '../../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from '../types';

export const pageAdminTools: ToolDef[] = [
  {
    name: 'wiki_pages_flush_cache',
    description: 'Flush the rendered-pages cache for the whole instance.',
    category: 'manage_system',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(`mutation{ pages { flushCache { ${DEFAULT_RESPONSE} } } }`);
      assertOk(data.pages.flushCache.responseResult, 'Flush cache');
      return ok({ flushed: true }, '✅ Page cache flushed.');
    },
  },
  {
    name: 'wiki_pages_rebuild_tree',
    description: 'Rebuild the internal page tree (repairs folder structure).',
    category: 'manage_system',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(`mutation{ pages { rebuildTree { ${DEFAULT_RESPONSE} } } }`);
      assertOk(data.pages.rebuildTree.responseResult, 'Rebuild tree');
      return ok({ rebuilt: true }, '✅ Page tree rebuilt.');
    },
  },
  {
    name: 'wiki_pages_migrate_locale',
    description: 'Migrate all pages from a source locale to a target locale.',
    category: 'manage_system',
    inputSchema: { sourceLocale: z.string(), targetLocale: z.string() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($sourceLocale:String!,$targetLocale:String!){ pages { migrateToLocale(sourceLocale:$sourceLocale,targetLocale:$targetLocale){ ${DEFAULT_RESPONSE} } } }`,
        { sourceLocale: a.sourceLocale, targetLocale: a.targetLocale },
      );
      assertOk(data.pages.migrateToLocale.responseResult, 'Migrate locale');
      return ok({ from: a.sourceLocale, to: a.targetLocale }, '✅ Locale migrated.');
    },
  },
];
