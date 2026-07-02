import { z } from 'zod';
import { ok, assertOk } from '../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from './types';

const COMMENT_FIELDS = 'id content render authorId authorName authorEmail createdAt updatedAt';

export const commentTools: ToolDef[] = [
  {
    name: 'wiki_comments_list',
    description: 'List comments on a page (by path + locale).',
    category: 'read',
    inputSchema: { path: z.string().min(1), locale: z.string().default('en') },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($locale:String!,$path:String!){ comments { list(locale:$locale,path:$path){ ${COMMENT_FIELDS} } } }`,
        { locale: a.locale ?? 'en', path: a.path },
      );
      return ok(data.comments.list);
    },
  },
  {
    name: 'wiki_comment_get',
    description: 'Get a single comment by id.',
    category: 'read',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($id:Int!){ comments { single(id:$id){ ${COMMENT_FIELDS} } } }`,
        { id: a.id },
      );
      return ok(data.comments.single);
    },
  },
  {
    name: 'wiki_comment_create',
    description: 'Post a comment on a page (rate-limited by Wiki.js to ~1 per 15s).',
    category: 'write',
    inputSchema: {
      pageId: z.number().int(),
      content: z.string().min(1),
      replyTo: z.number().int().optional().describe('Comment id to reply to.'),
      guestName: z.string().optional(),
      guestEmail: z.string().email().optional(),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($pageId:Int!,$replyTo:Int,$content:String!,$guestName:String,$guestEmail:String){ comments { create(pageId:$pageId,replyTo:$replyTo,content:$content,guestName:$guestName,guestEmail:$guestEmail){ ${DEFAULT_RESPONSE} id } } }`,
        { pageId: a.pageId, replyTo: a.replyTo, content: a.content, guestName: a.guestName, guestEmail: a.guestEmail },
      );
      assertOk(data.comments.create.responseResult, 'Create comment');
      return ok({ id: data.comments.create.id, pageId: a.pageId }, '✅ Comment posted.');
    },
  },
  {
    name: 'wiki_comment_update',
    description: 'Edit a comment.',
    category: 'write',
    inputSchema: { id: z.number().int(), content: z.string().min(1) },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($id:Int!,$content:String!){ comments { update(id:$id,content:$content){ ${DEFAULT_RESPONSE} render } } }`,
        { id: a.id, content: a.content },
      );
      assertOk(data.comments.update.responseResult, 'Update comment');
      return ok({ id: a.id }, '✅ Comment updated.');
    },
  },
  {
    name: 'wiki_comment_delete',
    description: 'Delete a comment by id.',
    category: 'delete',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($id:Int!){ comments { delete(id:$id){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id },
      );
      assertOk(data.comments.delete.responseResult, 'Delete comment');
      return ok({ id: a.id }, '🗑️ Comment deleted.');
    },
  },
];
