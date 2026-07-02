import { randomBytes } from 'crypto';
import { z } from 'zod';
import { ok, assertOk } from '../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from './types';
import type { WikiContext } from '../context';

/** Strong random password: base64url entropy + one char of each class (password-policy compliance). */
function generatePassword(): string {
  return randomBytes(16).toString('base64url') + 'A7!z';
}

const USER_MINIMAL = 'id name email providerKey isSystem isActive createdAt lastLoginAt';

// The Wiki.js users.search resolver only SELECTs id/email/name/providerKey/createdAt.
// UserMinimal.isSystem and .isActive are Boolean! — requesting them on a search hit yields
// "Cannot return null for non-nullable field UserMinimal.isSystem" and fails the whole query.
// So search requests only what the resolver provides; use wiki_users_list / wiki_user_get
// for the full record (those resolvers populate every field).
const USER_SEARCH_FIELDS = 'id name email providerKey createdAt';

/** Simple id-only mutations that return a DefaultResponse. */
function userIdMutation(name: string, field: string, label: string, verb: string): ToolDef {
  return {
    name,
    description: `${label} a user by id.`,
    category: 'manage_users',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx: WikiContext) => {
      const data = await ctx.client.request(
        `mutation($id:Int!){ users { ${field}(id:$id){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id },
      );
      // The mutation field can be null if Wiki.js returns no result (e.g. an unimplemented
      // resolver) — read defensively so we surface a clean message, not a TypeError.
      assertOk(data?.users?.[field]?.responseResult, `${label} user`);
      return ok({ id: a.id }, `✅ User ${verb}.`);
    },
  };
}

export const userTools: ToolDef[] = [
  {
    name: 'wiki_users_list',
    description: 'List users.',
    category: 'manage_users',
    inputSchema: {
      filter: z.string().optional(),
      orderBy: z.string().optional(),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($filter:String,$orderBy:String){ users { list(filter:$filter,orderBy:$orderBy){ ${USER_MINIMAL} } } }`,
        { filter: a.filter, orderBy: a.orderBy },
      );
      return ok(data.users.list);
    },
  },
  {
    name: 'wiki_users_search',
    description: 'Search users by name or email.',
    category: 'manage_users',
    inputSchema: { query: z.string().min(1) },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($query:String!){ users { search(query:$query){ ${USER_SEARCH_FIELDS} } } }`,
        { query: a.query },
      );
      return ok(data.users.search);
    },
  },
  {
    name: 'wiki_user_get',
    description: 'Get a single user with full profile and group memberships.',
    category: 'manage_users',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($id:Int!){ users { single(id:$id){ id name email providerKey providerName isSystem isActive isVerified location jobTitle timezone dateFormat appearance createdAt updatedAt lastLoginAt tfaIsActive groups { id name } } } }`,
        { id: a.id },
      );
      return ok(data.users.single);
    },
  },
  {
    name: 'wiki_user_profile',
    description: 'Get the profile of the currently authenticated user (the API key owner).',
    category: 'read',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(
        `query{ users { profile { id name email providerKey isSystem isVerified location jobTitle timezone dateFormat appearance createdAt updatedAt lastLoginAt groups pagesTotal } } }`,
      );
      return ok(data.users.profile);
    },
  },
  {
    name: 'wiki_users_last_logins',
    description: 'List the most recent user logins.',
    category: 'manage_users',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(`query{ users { lastLogins { id name lastLoginAt } } }`);
      return ok(data.users.lastLogins);
    },
  },
  {
    name: 'wiki_user_create',
    description: 'Create a new user.',
    category: 'manage_users',
    inputSchema: {
      email: z.string().email(),
      name: z.string().min(1),
      passwordRaw: z.string().optional().describe('Plain password (for local provider).'),
      providerKey: z.string().default('local'),
      groups: z.array(z.number().int()).default([]).describe('Group ids to assign.'),
      mustChangePassword: z.boolean().default(false),
      sendWelcomeEmail: z.boolean().default(false),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($email:String!,$name:String!,$passwordRaw:String,$providerKey:String!,$groups:[Int]!,$mustChangePassword:Boolean,$sendWelcomeEmail:Boolean){ users { create(email:$email,name:$name,passwordRaw:$passwordRaw,providerKey:$providerKey,groups:$groups,mustChangePassword:$mustChangePassword,sendWelcomeEmail:$sendWelcomeEmail){ ${DEFAULT_RESPONSE} user { id name email } } } }`,
        {
          email: a.email,
          name: a.name,
          passwordRaw: a.passwordRaw,
          providerKey: a.providerKey ?? 'local',
          groups: a.groups ?? [],
          mustChangePassword: a.mustChangePassword ?? false,
          sendWelcomeEmail: a.sendWelcomeEmail ?? false,
        },
      );
      assertOk(data.users.create.responseResult, 'Create user');
      // Wiki.js often returns no `user` object on create — look the new user up by email so the
      // caller gets id/name/email back instead of null.
      let user = data.users.create.user;
      if (!user?.id) {
        const found = await ctx.client.request<{ users: { search: { id: number; name: string; email: string }[] } }>(
          `query($q:String!){ users { search(query:$q){ id name email } } }`,
          { q: a.email },
        );
        user = found.users.search?.find((u) => u.email?.toLowerCase() === a.email.toLowerCase()) ?? user;
      }
      return ok({ ...(user ?? { email: a.email }), groups: a.groups ?? [] }, '✅ User created.');
    },
  },
  {
    name: 'wiki_user_update',
    description: 'Update a user (email, name, password, groups, profile fields).',
    category: 'manage_users',
    inputSchema: {
      id: z.number().int(),
      email: z.string().email().optional(),
      name: z.string().optional(),
      newPassword: z.string().optional(),
      groups: z.array(z.number().int()).optional(),
      location: z.string().optional(),
      jobTitle: z.string().optional(),
      timezone: z.string().optional(),
      dateFormat: z.string().optional(),
      appearance: z.string().optional(),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($id:Int!,$email:String,$name:String,$newPassword:String,$groups:[Int],$location:String,$jobTitle:String,$timezone:String,$dateFormat:String,$appearance:String){ users { update(id:$id,email:$email,name:$name,newPassword:$newPassword,groups:$groups,location:$location,jobTitle:$jobTitle,timezone:$timezone,dateFormat:$dateFormat,appearance:$appearance){ ${DEFAULT_RESPONSE} } } }`,
        {
          id: a.id,
          email: a.email,
          name: a.name,
          newPassword: a.newPassword,
          groups: a.groups,
          location: a.location,
          jobTitle: a.jobTitle,
          timezone: a.timezone,
          dateFormat: a.dateFormat,
          appearance: a.appearance,
        },
      );
      assertOk(data.users.update.responseResult, 'Update user');
      return ok({ id: a.id }, '✅ User updated.');
    },
  },
  {
    name: 'wiki_user_delete',
    description: 'Delete a user. Content owned by the user is reassigned to replaceId.',
    category: 'manage_users',
    inputSchema: {
      id: z.number().int(),
      replaceId: z.number().int().describe('User id that inherits the deleted user\'s content.'),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($id:Int!,$replaceId:Int!){ users { delete(id:$id,replaceId:$replaceId){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id, replaceId: a.replaceId },
      );
      assertOk(data.users.delete.responseResult, 'Delete user');
      return ok({ id: a.id }, '🗑️ User deleted.');
    },
  },
  userIdMutation('wiki_user_activate', 'activate', 'Activate', 'activated'),
  userIdMutation('wiki_user_deactivate', 'deactivate', 'Deactivate', 'deactivated'),
  userIdMutation('wiki_user_verify', 'verify', 'Verify', 'verified'),
  {
    // Wiki.js 2.x ships users.resetPassword as a no-op stub, so we implement a REAL reset via
    // the working users.update(newPassword) path. Provide newPassword, or omit it to generate
    // a strong one (returned once so the admin can hand it over).
    name: 'wiki_user_reset_password',
    description:
      "Reset a user's password to a new value. Wiki.js has no self-service reset API, so this SETS a " +
      'new password via users.update. Pass newPassword, or omit it to auto-generate a strong one — the ' +
      'new password is returned once in the result, so handle it carefully (the user should change it).',
    category: 'manage_users',
    inputSchema: {
      id: z.number().int(),
      newPassword: z.string().min(8).optional().describe('New password. Omit to auto-generate a strong random one.'),
    },
    handler: async (a, ctx) => {
      const generated = !a.newPassword;
      const newPassword = a.newPassword ?? generatePassword();
      const data = await ctx.client.request(
        `mutation($id:Int!,$newPassword:String){ users { update(id:$id,newPassword:$newPassword){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id, newPassword },
      );
      assertOk(data.users.update.responseResult, 'Reset password');
      return ok(
        { id: a.id, newPassword, generated },
        generated
          ? '✅ Password reset to a generated value (shown once above — share it securely; the user should change it).'
          : '✅ Password reset.',
      );
    },
  },
  userIdMutation('wiki_user_disable_tfa', 'disableTFA', 'Disable 2FA for', '2FA disabled'),
];
