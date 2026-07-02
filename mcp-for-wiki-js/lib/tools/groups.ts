import { z } from 'zod';
import { ok, assertOk } from '../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from './types';

interface FullGroup {
  id: number;
  name: string;
  redirectOnLogin: string | null;
  permissions: string[];
  pageRules: {
    id: string;
    deny: boolean;
    match: string;
    roles: string[];
    path: string;
    locales: string[];
  }[];
}

export const groupTools: ToolDef[] = [
  {
    name: 'wiki_groups_list',
    description: 'List user groups.',
    category: 'manage_groups',
    inputSchema: { filter: z.string().optional(), orderBy: z.string().optional() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($filter:String,$orderBy:String){ groups { list(filter:$filter,orderBy:$orderBy){ id name isSystem userCount createdAt updatedAt } } }`,
        { filter: a.filter, orderBy: a.orderBy },
      );
      return ok(data.groups.list);
    },
  },
  {
    name: 'wiki_group_get',
    description: 'Get a single group including permissions, page rules and members.',
    category: 'manage_groups',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($id:Int!){ groups { single(id:$id){ id name isSystem redirectOnLogin permissions pageRules { id deny match roles path locales } users { id name email } createdAt updatedAt } } }`,
        { id: a.id },
      );
      return ok(data.groups.single);
    },
  },
  {
    name: 'wiki_group_create',
    description: 'Create a new (empty) group.',
    category: 'manage_groups',
    inputSchema: { name: z.string().min(1) },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($name:String!){ groups { create(name:$name){ ${DEFAULT_RESPONSE} group { id name } } } }`,
        { name: a.name },
      );
      assertOk(data.groups.create.responseResult, 'Create group');
      return ok(data.groups.create.group, '✅ Group created.');
    },
  },
  {
    name: 'wiki_group_update',
    description:
      'Update a group. Only the fields you pass change; permissions and pageRules you omit are preserved (read from the current group first). pageRules is the full ruleset when provided.',
    category: 'manage_groups',
    inputSchema: {
      id: z.number().int(),
      name: z.string().optional(),
      redirectOnLogin: z.string().optional(),
      permissions: z.array(z.string()).optional().describe('Global permission keys, e.g. "read:pages".'),
      pageRules: z
        .array(
          z.object({
            id: z.string(),
            deny: z.boolean(),
            match: z.enum(['START', 'EXACT', 'END', 'REGEX', 'TAG']),
            roles: z.array(z.string()),
            path: z.string(),
            locales: z.array(z.string()),
          }),
        )
        .optional(),
    },
    handler: async (a, ctx) => {
      // Fetch current group so omitted fields are preserved (the mutation requires all of them).
      const cur = await ctx.client.request<{ groups: { single: FullGroup } }>(
        `query($id:Int!){ groups { single(id:$id){ id name redirectOnLogin permissions pageRules { id deny match roles path locales } } } }`,
        { id: a.id },
      );
      const g = cur.groups.single;
      if (!g) throw new Error(`No group with id ${a.id}`);
      const data = await ctx.client.request(
        `mutation($id:Int!,$name:String!,$redirectOnLogin:String!,$permissions:[String]!,$pageRules:[PageRuleInput]!){ groups { update(id:$id,name:$name,redirectOnLogin:$redirectOnLogin,permissions:$permissions,pageRules:$pageRules){ ${DEFAULT_RESPONSE} } } }`,
        {
          id: a.id,
          name: a.name ?? g.name,
          redirectOnLogin: a.redirectOnLogin ?? g.redirectOnLogin ?? '/',
          permissions: a.permissions ?? g.permissions,
          pageRules: a.pageRules ?? g.pageRules,
        },
      );
      assertOk(data.groups.update.responseResult, 'Update group');
      return ok({ id: a.id }, '✅ Group updated.');
    },
  },
  {
    name: 'wiki_group_delete',
    description: 'Delete a group by id.',
    category: 'manage_groups',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($id:Int!){ groups { delete(id:$id){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id },
      );
      assertOk(data.groups.delete.responseResult, 'Delete group');
      return ok({ id: a.id }, '🗑️ Group deleted.');
    },
  },
  {
    name: 'wiki_group_assign_user',
    description: 'Add a user to a group.',
    category: 'manage_groups',
    inputSchema: { groupId: z.number().int(), userId: z.number().int() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($groupId:Int!,$userId:Int!){ groups { assignUser(groupId:$groupId,userId:$userId){ ${DEFAULT_RESPONSE} } } }`,
        { groupId: a.groupId, userId: a.userId },
      );
      assertOk(data.groups.assignUser.responseResult, 'Assign user');
      return ok({ groupId: a.groupId, userId: a.userId }, '✅ User assigned to group.');
    },
  },
  {
    name: 'wiki_group_unassign_user',
    description: 'Remove a user from a group.',
    category: 'manage_groups',
    inputSchema: { groupId: z.number().int(), userId: z.number().int() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($groupId:Int!,$userId:Int!){ groups { unassignUser(groupId:$groupId,userId:$userId){ ${DEFAULT_RESPONSE} } } }`,
        { groupId: a.groupId, userId: a.userId },
      );
      assertOk(data.groups.unassignUser.responseResult, 'Unassign user');
      return ok({ groupId: a.groupId, userId: a.userId }, '✅ User removed from group.');
    },
  },
];
