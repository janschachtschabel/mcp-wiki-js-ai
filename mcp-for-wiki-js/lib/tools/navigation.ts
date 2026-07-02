import { z } from 'zod';
import { ok, fail, assertOk } from '../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from './types';

const TREE_QUERY =
  `query{ navigation { tree { locale items { id kind label icon targetType target visibilityMode visibilityGroups } } } }`;

type NavTree = { locale: string; items: unknown[] };

/**
 * Wiki.js stores the WHOLE navigation as a single `key='site'` blob and `updateTree`
 * REPLACES it wholesale — it does not merge per locale. So passing fewer locales (or
 * empty items) silently DELETES the omitted/emptied navigation. This pure helper compares
 * the current tree against the proposed one and returns a human-readable list of the
 * destructive losses (locales removed, or a non-empty locale cleared). Empty list = safe.
 */
export function navigationLosses(current: NavTree[], next: NavTree[]): string[] {
  const nextByLocale = new Map(next.map((t) => [t.locale, t.items ?? []]));
  const losses: string[] = [];
  for (const cur of current) {
    const had = (cur.items ?? []).length;
    if (had === 0) continue; // nothing to lose for this locale
    if (!nextByLocale.has(cur.locale)) {
      losses.push(`locale "${cur.locale}" (${had} item(s)) would be REMOVED entirely`);
    } else if ((nextByLocale.get(cur.locale) ?? []).length === 0) {
      losses.push(`locale "${cur.locale}" would be CLEARED (${had} → 0 items)`);
    }
  }
  return losses;
}

export const navigationTools: ToolDef[] = [
  {
    name: 'wiki_navigation_get',
    description: 'Get the site navigation tree (per locale).',
    category: 'read',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(TREE_QUERY);
      return ok(data.navigation.tree);
    },
  },
  {
    name: 'wiki_navigation_update_tree',
    description:
      'REPLACE the entire site navigation with the given tree (array of { locale, items: [...] }, ' +
      'same shape as wiki_navigation_get returns). ⚠️ Wiki.js stores navigation as ONE blob: this ' +
      'OVERWRITES ALL locales at once — it does NOT merge. Omitting a locale or passing empty items ' +
      'DELETES that navigation. The current tree is always returned as a rollback payload; a change ' +
      'that would remove or empty existing navigation is REFUSED unless you pass force=true.',
    category: 'manage_system',
    inputSchema: {
      tree: z
        .array(
          z.object({
            locale: z.string(),
            items: z.array(z.record(z.any())),
          }),
        )
        .describe('Full navigation tree to set (REPLACES everything — include every locale you want to keep).'),
      force: z
        .boolean()
        .default(false)
        .describe('Required to proceed when the change would delete or empty existing navigation.'),
    },
    handler: async (a, ctx) => {
      // Always snapshot the current navigation first — this is the rollback payload.
      const before = await ctx.client.request<{ navigation: { tree: NavTree[] } }>(TREE_QUERY);
      const current: NavTree[] = before.navigation.tree ?? [];
      const next: NavTree[] = a.tree ?? [];

      const losses = navigationLosses(current, next);
      if (losses.length > 0 && a.force !== true) {
        return fail(
          `Refusing a destructive navigation change (force not set):\n - ${losses.join('\n - ')}\n\n` +
            `Wiki.js replaces the WHOLE navigation at once, so any omitted/emptied locale is lost. ` +
            `If this is intentional, retry the same call with "force": true.\n\n` +
            `ROLLBACK — the current navigation (pass this exact value back as "tree" to restore it):\n` +
            JSON.stringify(current, null, 2),
        );
      }

      const data = await ctx.client.request(
        `mutation($tree:[NavigationTreeInput]!){ navigation { updateTree(tree:$tree){ ${DEFAULT_RESPONSE} } } }`,
        { tree: next },
      );
      assertOk(data.navigation.updateTree.responseResult, 'Update navigation');
      return ok(
        { locales: next.map((t) => t.locale), previous: current },
        '✅ Navigation updated. The "previous" field holds the prior tree — pass it back as "tree" to roll back.',
      );
    },
  },
];
