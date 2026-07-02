import { z } from 'zod';
import { ok, assertOk } from '../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from './types';

export const systemTools: ToolDef[] = [
  // ------------------------------------------------------------- DIAGNOSTIC ---
  {
    name: 'wiki_connection_status',
    description:
      'Check connectivity and authentication against the configured Wiki.js instance. Safe, read-only.',
    category: 'read',
    inputSchema: {},
    handler: async (_a, ctx) => {
      try {
        await ctx.client.request(`query{ pages { list(limit:1){ id } } }`);
        return ok({ connected: true, authenticated: true, baseUrl: ctx.baseUrl, hasToken: ctx.hasToken, profile: ctx.profile ?? null });
      } catch (e) {
        return ok({
          connected: false,
          baseUrl: ctx.baseUrl,
          hasToken: ctx.hasToken,
          profile: ctx.profile ?? null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  },
  {
    name: 'wiki_site_info',
    description: 'Get basic site info (title, description, host). May require admin scope on some instances.',
    category: 'read',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(`query{ site { config { title description host } } }`);
      return ok(data.site.config);
    },
  },

  // ----------------------------------------------------------- MANAGE_SYSTEM ---
  {
    name: 'wiki_site_config',
    description: 'Get the full site configuration.',
    category: 'manage_system',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(
        `query{ site { config { host title description robots company contentLicense logoUrl featurePageRatings featurePageComments featurePersonalWikis } } }`,
      );
      return ok(data.site.config);
    },
  },
  {
    name: 'wiki_system_info',
    description: 'Get system/runtime information (versions, host, database).',
    category: 'manage_system',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(
        `query{ system { info { currentVersion latestVersion nodeVersion hostname operatingSystem cpuCores ramTotal dbType dbVersion } } }`,
      );
      return ok(data.system.info);
    },
  },
  {
    name: 'wiki_system_flags',
    description: 'List system feature flags.',
    category: 'manage_system',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(`query{ system { flags { key value } } }`);
      return ok(data.system.flags);
    },
  },

  // ------------------------------------------------------------- MANAGE_AUTH ---
  {
    name: 'wiki_apikeys_list',
    description: 'List Wiki.js API keys (metadata only — never the secret).',
    category: 'manage_auth',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(
        `query{ authentication { apiKeys { id name keyShort expiration createdAt updatedAt isRevoked } } }`,
      );
      return ok(data.authentication.apiKeys);
    },
  },
  {
    name: 'wiki_apikey_create',
    description: 'Create a new Wiki.js API key. The full secret is only returned once.',
    category: 'manage_auth',
    inputSchema: {
      name: z.string().min(1),
      expiration: z.string().default('365d').describe('Expiration, e.g. "30d", "1y", "365d".'),
      fullAccess: z.boolean().default(false),
      group: z.number().int().optional().describe('Restrict key to a group id (when not fullAccess).'),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($name:String!,$expiration:String!,$fullAccess:Boolean!,$group:Int){ authentication { createApiKey(name:$name,expiration:$expiration,fullAccess:$fullAccess,group:$group){ ${DEFAULT_RESPONSE} key } } }`,
        { name: a.name, expiration: a.expiration ?? '365d', fullAccess: a.fullAccess ?? false, group: a.group },
      );
      assertOk(data.authentication.createApiKey.responseResult, 'Create API key');
      return ok(
        { name: a.name, key: data.authentication.createApiKey.key },
        '✅ API key created. Store the secret now — it will not be shown again.',
      );
    },
  },
  {
    name: 'wiki_apikey_revoke',
    description: 'Revoke a Wiki.js API key by id.',
    category: 'manage_auth',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($id:Int!){ authentication { revokeApiKey(id:$id){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id },
      );
      assertOk(data.authentication.revokeApiKey.responseResult, 'Revoke API key');
      return ok({ id: a.id }, '🗑️ API key revoked.');
    },
  },
  {
    name: 'wiki_auth_strategies',
    description: 'List active authentication strategies.',
    category: 'manage_auth',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(
        `query{ authentication { activeStrategies { key displayName order isEnabled selfRegistration } } }`,
      );
      return ok(data.authentication.activeStrategies);
    },
  },
  {
    name: 'wiki_auth_set_api_state',
    description: 'Enable or disable the Wiki.js GraphQL API globally.',
    category: 'manage_auth',
    inputSchema: { enabled: z.boolean() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($enabled:Boolean!){ authentication { setApiState(enabled:$enabled){ ${DEFAULT_RESPONSE} } } }`,
        { enabled: a.enabled },
      );
      assertOk(data.authentication.setApiState.responseResult, 'Set API state');
      return ok({ enabled: a.enabled }, '✅ API state updated.');
    },
  },

  // -------------------------------------------------------------- ESCAPE HATCH ---
  {
    name: 'wiki_graphql',
    description:
      'Run an arbitrary Wiki.js GraphQL query or mutation. Use for any operation not covered by a ' +
      'dedicated tool. Powerful — gated under the manage_system category. Safety net: a raw MUTATION ' +
      'returns a dry-run preview unless you pass confirm=true; plain queries run directly.',
    category: 'manage_system',
    inputSchema: {
      query: z.string().min(1).describe('GraphQL query or mutation document.'),
      variables: z.record(z.any()).optional().describe('Variables object for the query.'),
    },
    handler: async (a, ctx) => {
      // The escape hatch can run ANY mutation (delete pages, wipe navigation, revoke API keys, …).
      // Even when policy sets manage_system to "allow", never execute a raw mutation without an
      // explicit confirm — return a dry-run preview first. Read queries are unaffected.
      const isMutation = /(^|[\s{(])mutation\b/i.test(a.query);
      if (isMutation && a.confirm !== true) {
        return ok(
          { dryRun: true, operation: 'mutation', query: a.query, variables: a.variables ?? {} },
          '⚠️ Raw GraphQL MUTATION — DRY RUN, nothing executed. Review it, then call again with "confirm": true to run it.',
        );
      }
      const data = await ctx.client.request(a.query, a.variables ?? {});
      return ok(data);
    },
  },
];
