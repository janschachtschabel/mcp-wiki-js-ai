import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { WikiContext } from '../../context';
import { ok, assertOk, assertNotTruncated } from '../../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from '../types';
import { parameterGate } from '../gate';
import { assertPageIdNotBlocked, assertTagIdNotBlocked, assertTagsNotBlocked } from '../../guardrails';
import { requirePageId } from './shared';

/**
 * Page JS/CSS runs for every visitor of the page (stored XSS in the wiki origin),
 * so setting it needs the manage_system mode — policy key "wiki_page_scripts" —
 * on top of the write category (audit R-18). Carrying existing scripts over on
 * an update is not "setting" them.
 */
function scriptGate(a: { scriptJs?: string; scriptCss?: string; confirm?: unknown }, ctx: WikiContext): CallToolResult | undefined {
  if (a.scriptJs === undefined && a.scriptCss === undefined) return undefined;
  return parameterGate(ctx, {
    policyKey: 'wiki_page_scripts',
    category: 'manage_system',
    what: '"scriptJs"/"scriptCss"',
    confirm: a.confirm,
    dryRun: { scriptJs: a.scriptJs, scriptCss: a.scriptCss },
  });
}

const scriptField = (what: string) =>
  z.string().optional().describe(`Page ${what}. Setting it needs the manage_system policy mode (it runs for every visitor).`);

export const pageWriteTools: ToolDef[] = [
  {
    name: 'wiki_page_create',
    description: 'Create a new page at the given path with markdown content.',
    category: 'write',
    inputSchema: {
      path: z.string().min(1).describe('Page path, e.g. "docs/getting-started".'),
      title: z.string().min(1),
      content: z.string().describe('Page body (markdown by default).'),
      description: z.string().default(''),
      editor: z.string().default('markdown').describe('Editor type: markdown | html | ...'),
      locale: z.string().default('en'),
      tags: z.array(z.string()).default([]),
      isPublished: z.boolean().default(true),
      isPrivate: z.boolean().default(false),
      scriptCss: scriptField('CSS'),
      scriptJs: scriptField('JavaScript'),
    },
    handler: async (a, ctx) => {
      const gated = scriptGate(a, ctx);
      if (gated) return gated;
      assertNotTruncated(a.content);
      const data = await ctx.client.request(
        `mutation($content:String!,$description:String!,$editor:String!,$isPublished:Boolean!,$isPrivate:Boolean!,$locale:String!,$path:String!,$tags:[String]!,$title:String!,$scriptCss:String,$scriptJs:String){ pages { create(content:$content,description:$description,editor:$editor,isPublished:$isPublished,isPrivate:$isPrivate,locale:$locale,path:$path,tags:$tags,title:$title,scriptCss:$scriptCss,scriptJs:$scriptJs){ ${DEFAULT_RESPONSE} page { id path title } } } }`,
        {
          content: a.content,
          description: a.description ?? '',
          editor: a.editor ?? 'markdown',
          isPublished: a.isPublished ?? true,
          isPrivate: a.isPrivate ?? false,
          locale: a.locale ?? 'en',
          path: a.path,
          tags: a.tags ?? [],
          title: a.title,
          scriptCss: a.scriptCss,
          scriptJs: a.scriptJs,
        },
      );
      assertOk(data.pages.create.responseResult, 'Create page');
      return ok(data.pages.create.page, '✅ Page created.');
    },
  },
  {
    name: 'wiki_page_update',
    description:
      'Update a page by id. Either replace the whole content, or apply surgical edits=[{find,replace}] to the existing content. Fields you omit are preserved (the current page is fetched first), so metadata-only updates never wipe content/tags.',
    category: 'write',
    inputSchema: {
      id: z.number().int(),
      content: z.string().optional().describe('Full replacement content.'),
      edits: z
        .array(z.object({ find: z.string().min(1), replace: z.string() }))
        .optional()
        .describe('Find/replace edits applied to current content (alternative to content). Each edit replaces ALL occurrences of "find".'),
      title: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      editor: z.string().optional(),
      locale: z.string().optional(),
      path: z.string().optional().describe('New path (renames the page).'),
      isPublished: z.boolean().optional(),
      isPrivate: z.boolean().optional(),
      scriptCss: scriptField('CSS'),
      scriptJs: scriptField('JavaScript'),
    },
    handler: async (a, ctx) => {
      if (a.content != null && a.edits && a.edits.length > 0) {
        throw new Error('Provide either "content" or "edits", not both.');
      }
      const gated = scriptGate(a, ctx);
      if (gated) return gated;
      assertNotTruncated(a.content);
      // Fetch the current page so omitted fields are preserved. Wiki.js' update
      // mutation otherwise clears unspecified required fields (content, tags, ...).
      type Cur = {
        path: string;
        locale: string;
        title: string;
        description: string;
        editor: string;
        isPublished: boolean;
        isPrivate: boolean;
        content: string;
        tags: { tag: string }[];
        scriptCss: string | null;
        scriptJs: string | null;
      };
      const cur = await ctx.client.request<{ pages: { single: Cur | null } }>(
        `query($id:Int!){ pages { single(id:$id){ path locale title description editor isPublished isPrivate content tags { tag } scriptCss scriptJs } } }`,
        { id: a.id },
      );
      const p = cur.pages.single;
      if (!p) throw new Error(`No page with id ${a.id}`);
      assertTagsNotBlocked(p.tags, `Page ${a.id}`);

      let content = a.content ?? p.content ?? '';
      if (a.edits && a.edits.length > 0) {
        let body = p.content ?? '';
        for (const e of a.edits) {
          if (!body.includes(e.find)) throw new Error(`edit failed: text not found: ${JSON.stringify(e.find)}`);
          body = body.split(e.find).join(e.replace);
        }
        content = body;
      }
      const tags = a.tags ?? (p.tags ?? []).map((t) => t.tag);

      const data = await ctx.client.request(
        `mutation($id:Int!,$content:String,$description:String,$editor:String,$isPrivate:Boolean,$isPublished:Boolean,$locale:String,$path:String,$tags:[String],$title:String,$scriptCss:String,$scriptJs:String){ pages { update(id:$id,content:$content,description:$description,editor:$editor,isPrivate:$isPrivate,isPublished:$isPublished,locale:$locale,path:$path,tags:$tags,title:$title,scriptCss:$scriptCss,scriptJs:$scriptJs){ ${DEFAULT_RESPONSE} page { id path title updatedAt } } } }`,
        {
          id: a.id,
          content,
          description: a.description ?? p.description ?? '',
          editor: a.editor ?? p.editor,
          isPrivate: a.isPrivate ?? p.isPrivate,
          isPublished: a.isPublished ?? p.isPublished,
          locale: a.locale ?? p.locale,
          path: a.path ?? p.path,
          tags,
          title: a.title ?? p.title,
          // Wiki.js resets omitted scripts to '' for users with write:styles/scripts.
          scriptCss: a.scriptCss ?? p.scriptCss ?? '',
          scriptJs: a.scriptJs ?? p.scriptJs ?? '',
        },
      );
      assertOk(data.pages.update.responseResult, 'Update page');
      return ok(data.pages.update.page, '✅ Page updated.');
    },
  },
  {
    name: 'wiki_page_move',
    description: 'Move/rename a page (identified by id OR path+locale) to a new path and/or locale.',
    category: 'write',
    inputSchema: {
      id: z.number().int().optional().describe('Page id (or use path+locale).'),
      path: z.string().optional().describe('Current page path (alternative to id).'),
      locale: z.string().default('en').describe('Current locale (for path lookup).'),
      destinationPath: z.string().min(1),
      destinationLocale: z.string().optional().describe('Target locale. Default: the page keeps its current locale.'),
    },
    handler: async (a, ctx) => {
      const id = await requirePageId(ctx, a);
      await assertPageIdNotBlocked(ctx, id, `Page ${id}`);
      // Without an explicit target the page stays in its own locale (audit R-29).
      let destinationLocale: string | undefined = a.destinationLocale;
      if (!destinationLocale && a.id == null) destinationLocale = a.locale ?? 'en';
      if (!destinationLocale) {
        const cur = await ctx.client.request<{ pages: { single: { locale: string } | null } }>(
          `query($id:Int!){ pages { single(id:$id){ locale } } }`,
          { id },
        );
        if (!cur.pages.single) throw new Error(`No page with id ${id}`);
        destinationLocale = cur.pages.single.locale;
      }
      const data = await ctx.client.request(
        `mutation($id:Int!,$destinationPath:String!,$destinationLocale:String!){ pages { move(id:$id,destinationPath:$destinationPath,destinationLocale:$destinationLocale){ ${DEFAULT_RESPONSE} } } }`,
        { id, destinationPath: a.destinationPath, destinationLocale },
      );
      assertOk(data.pages.move.responseResult, 'Move page');
      return ok({ id, destinationPath: a.destinationPath, destinationLocale }, '✅ Page moved.');
    },
  },
  {
    name: 'wiki_page_render',
    description: 'Re-render a page (rebuild its cached HTML output).',
    category: 'write',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx) => {
      await assertPageIdNotBlocked(ctx, a.id, `Page ${a.id}`);
      const data = await ctx.client.request(
        `mutation($id:Int!){ pages { render(id:$id){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id },
      );
      assertOk(data.pages.render.responseResult, 'Render page');
      return ok({ id: a.id }, '✅ Page re-rendered.');
    },
  },
  {
    name: 'wiki_page_restore',
    description: 'Restore a page to a previous version.',
    category: 'write',
    annotations: { destructiveHint: true },
    inputSchema: { pageId: z.number().int(), versionId: z.number().int() },
    handler: async (a, ctx) => {
      await assertPageIdNotBlocked(ctx, a.pageId, `Page ${a.pageId}`);
      const data = await ctx.client.request(
        `mutation($pageId:Int!,$versionId:Int!){ pages { restore(pageId:$pageId,versionId:$versionId){ ${DEFAULT_RESPONSE} } } }`,
        { pageId: a.pageId, versionId: a.versionId },
      );
      assertOk(data.pages.restore.responseResult, 'Restore page');
      return ok({ pageId: a.pageId, versionId: a.versionId }, '✅ Page restored.');
    },
  },
  {
    name: 'wiki_page_convert',
    description: 'Convert a page to a different editor/content type (e.g. markdown → html).',
    category: 'write',
    inputSchema: { id: z.number().int(), editor: z.string().describe('Target editor, e.g. "markdown".') },
    handler: async (a, ctx) => {
      await assertPageIdNotBlocked(ctx, a.id, `Page ${a.id}`);
      const data = await ctx.client.request(
        `mutation($id:Int!,$editor:String!){ pages { convert(id:$id,editor:$editor){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id, editor: a.editor },
      );
      assertOk(data.pages.convert.responseResult, 'Convert page');
      return ok({ id: a.id, editor: a.editor }, '✅ Page converted.');
    },
  },
  {
    name: 'wiki_tag_update',
    description: 'Rename / retitle a tag.',
    category: 'write',
    inputSchema: { id: z.number().int(), tag: z.string(), title: z.string() },
    handler: async (a, ctx) => {
      // Renaming a guardrail tag would un-block every page carrying it.
      await assertTagIdNotBlocked(ctx, a.id, 'Tag update');
      const data = await ctx.client.request(
        `mutation($id:Int!,$tag:String!,$title:String!){ pages { updateTag(id:$id,tag:$tag,title:$title){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id, tag: a.tag, title: a.title },
      );
      assertOk(data.pages.updateTag.responseResult, 'Update tag');
      return ok({ id: a.id, tag: a.tag }, '✅ Tag updated.');
    },
  },
];
