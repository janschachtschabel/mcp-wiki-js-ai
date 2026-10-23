import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { WikiContext } from '../../context';
import { ok, assertOk, assertNotTruncated } from '../../wikijs/format';
import { DEFAULT_RESPONSE, type ToolDef } from '../types';
import { parameterGate } from '../gate';
import { assertPageIdNotBlocked, assertTagIdNotBlocked, assertTagsNotBlocked } from '../../guardrails';
import { MCP_BODY_LIMIT } from '../../body-limit';
import { fetchLatestPage, findListedPage, isViewForbidden, requirePageId } from './shared';
import { localeOrSite } from '../../wikijs/site-locale';

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

/**
 * Upper bound for a page built from edits (audit A-07): one short "find" with a long
 * "replace" would otherwise multiply into a string far beyond any request size.
 * Same bound a caller could send as "content" directly.
 */
const MAX_EDITED_CONTENT = MCP_BODY_LIMIT;

/** Apply find/replace edits, refusing a missing "find" and a result over the bound — before building it. */
function applyEdits(body: string, edits: { find: string; replace: string }[]): string {
  for (const e of edits) {
    const parts = body.split(e.find);
    if (parts.length === 1) throw new Error(`edit failed: text not found: ${JSON.stringify(e.find)}`);
    const length = body.length + (parts.length - 1) * (e.replace.length - e.find.length);
    if (length > MAX_EDITED_CONTENT) {
      throw new Error(`edit refused: the result would be ${length} characters (limit ${MAX_EDITED_CONTENT}).`);
    }
    body = parts.join(e.replace);
  }
  return body;
}

const scriptField = (what: string) =>
  z.string().optional().describe(`Page ${what}. Setting it needs the manage_system policy mode (it runs for every visitor).`);

const publishDateField = (edge: 'start' | 'end') =>
  z
    .string()
    .refine((v) => v === '' || !Number.isNaN(Date.parse(v)), 'Expected an ISO 8601 date-time or "" (clear).')
    .optional()
    .describe(`Scheduled publish ${edge} (ISO 8601, e.g. 2030-01-01T00:00:00Z); "" clears it. Omitted = keep the current value where it can be read.`);

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
      locale: z.string().optional().describe("Default: the wiki's site locale."),
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
          locale: await localeOrSite(ctx, a.locale),
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
      publishStartDate: publishDateField('start'),
      publishEndDate: publishDateField('end'),
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
        editor?: string;
        isPublished: boolean;
        isPrivate?: boolean;
        content: string;
        tags: Array<string | { tag: string }>; // single: objects, conflictLatest: strings
        scriptCss?: string | null;
        scriptJs?: string | null;
        publishStartDate?: string;
        publishEndDate?: string;
      };
      let p: Cur;
      let scriptsKnown = true;
      try {
        const cur = await ctx.client.request<{ pages: { single: Cur | null } }>(
          `query($id:Int!){ pages { single(id:$id){ path locale title description editor isPublished isPrivate publishStartDate publishEndDate content tags { tag } scriptCss scriptJs } } }`,
          { id: a.id },
        );
        if (!cur.pages.single) throw new Error(`No page with id ${a.id}`);
        p = cur.pages.single;
      } catch (err) {
        // A-01: without manage:pages, read the page via conflictLatest (write:pages).
        // It has no scripts; Wiki.js keeps them unless the user holds write:scripts/
        // write:styles, where an omitted value clears them — rare without manage:pages.
        if (!isViewForbidden(err)) throw err;
        p = await fetchLatestPage(ctx, a.id);
        scriptsKnown = false;
      }
      assertTagsNotBlocked(p.tags, `Page ${a.id}`);

      let content = a.content ?? p.content ?? '';
      if (a.edits && a.edits.length > 0) content = applyEdits(p.content ?? '', a.edits);
      const tags = a.tags ?? (p.tags ?? []).map((t) => (typeof t === 'string' ? t : t.tag));
      // Wiki.js resets an omitted publish window to '' (live-verified), and only
      // pages.single (manage:pages) can read it. '' is sent as "omitted": new Date('')
      // would be stored as an invalid date.
      const publishWindow = (given: string | undefined, current: string | undefined) => (given !== undefined ? given : current) || undefined;
      const windowUnknown = !scriptsKnown && a.publishStartDate === undefined && a.publishEndDate === undefined;

      const data = await ctx.client.request(
        `mutation($id:Int!,$content:String,$description:String,$editor:String,$isPrivate:Boolean,$isPublished:Boolean,$locale:String,$path:String,$publishStartDate:Date,$publishEndDate:Date,$tags:[String],$title:String,$scriptCss:String,$scriptJs:String){ pages { update(id:$id,content:$content,description:$description,editor:$editor,isPrivate:$isPrivate,isPublished:$isPublished,locale:$locale,path:$path,publishStartDate:$publishStartDate,publishEndDate:$publishEndDate,tags:$tags,title:$title,scriptCss:$scriptCss,scriptJs:$scriptJs){ ${DEFAULT_RESPONSE} page { id path title updatedAt } } } }`,
        {
          id: a.id,
          content,
          description: a.description ?? p.description ?? '',
          editor: a.editor ?? p.editor,
          isPrivate: a.isPrivate ?? p.isPrivate,
          isPublished: a.isPublished ?? p.isPublished,
          locale: a.locale ?? p.locale,
          path: a.path ?? p.path,
          publishStartDate: publishWindow(a.publishStartDate, p.publishStartDate),
          publishEndDate: publishWindow(a.publishEndDate, p.publishEndDate),
          tags,
          title: a.title ?? p.title,
          // Wiki.js resets omitted scripts to '' for users with write:styles/scripts.
          scriptCss: a.scriptCss ?? (scriptsKnown ? (p.scriptCss ?? '') : undefined),
          scriptJs: a.scriptJs ?? (scriptsKnown ? (p.scriptJs ?? '') : undefined),
        },
      );
      assertOk(data.pages.update.responseResult, 'Update page');
      return ok(
        data.pages.update.page,
        windowUnknown
          ? '✅ Page updated. Note: without manage:pages the scheduled publish window cannot be read, so Wiki.js cleared it if one was set — pass publishStartDate/publishEndDate to keep it.'
          : '✅ Page updated.',
      );
    },
  },
  {
    name: 'wiki_page_move',
    description: 'Move/rename a page (identified by id OR path+locale) to a new path and/or locale.',
    category: 'write',
    inputSchema: {
      id: z.number().int().optional().describe('Page id (or use path+locale).'),
      path: z.string().optional().describe('Current page path (alternative to id).'),
      locale: z.string().optional().describe("Current locale (for path lookup). Default: the wiki's site locale."),
      destinationPath: z.string().min(1),
      destinationLocale: z.string().optional().describe('Target locale. Default: the page keeps its current locale.'),
    },
    handler: async (a, ctx) => {
      const id = await requirePageId(ctx, a);
      await assertPageIdNotBlocked(ctx, id, `Page ${id}`);
      // Without an explicit target the page stays in its own locale (audit R-29).
      let destinationLocale: string | undefined = a.destinationLocale;
      if (!destinationLocale && a.id == null) destinationLocale = await localeOrSite(ctx, a.locale);
      if (!destinationLocale) {
        const cur = await findListedPage(ctx, { id });
        if (!cur) throw new Error(`No page with id ${id}`);
        destinationLocale = cur.locale;
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
    category: 'manage_system', // Wiki.js: manage:system (audit A-12)
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
      // Wiki.js restores through updatePage with the version's tags, and versions carry
      // none: every tag is dropped (audit A-18). Name them so they can be re-applied —
      // best effort: the restore itself does not depend on reading them.
      let tags: string[] | undefined;
      let tagsUnreadable = '';
      try {
        tags = (await fetchLatestPage(ctx, a.pageId)).tags;
      } catch (e) {
        tagsUnreadable = e instanceof Error ? e.message : String(e);
      }
      const data = await ctx.client.request(
        `mutation($pageId:Int!,$versionId:Int!){ pages { restore(pageId:$pageId,versionId:$versionId){ ${DEFAULT_RESPONSE} } } }`,
        { pageId: a.pageId, versionId: a.versionId },
      );
      assertOk(data.pages.restore.responseResult, 'Restore page');
      if (tags === undefined) {
        return ok(
          { pageId: a.pageId, versionId: a.versionId },
          `✅ Page restored. ⚠️ Wiki.js removes all tags on restore; the previous tags could not be read (${tagsUnreadable}) — check them with wiki_page_get.`,
        );
      }
      if (tags.length === 0) return ok({ pageId: a.pageId, versionId: a.versionId }, '✅ Page restored.');
      return ok(
        { pageId: a.pageId, versionId: a.versionId, tagsRemoved: tags },
        `✅ Page restored. ⚠️ Wiki.js removed all tags on restore (${tags.join(', ')}) — re-apply them with wiki_page_update (tags).`,
      );
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
    category: 'manage_system', // Wiki.js: manage:system (audit A-12)
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
