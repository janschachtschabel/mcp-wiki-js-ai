import { z } from 'zod';
import { ok, fail, assertOk } from '../wikijs/format';
import { AssetTooLargeError } from '../wikijs/client';
import { DEFAULT_RESPONSE, type ToolDef } from './types';

export const assetTools: ToolDef[] = [
  {
    name: 'wiki_assets_list',
    description: 'List assets (files/images) inside an asset folder.',
    category: 'read',
    inputSchema: {
      folderId: z.number().int().default(0).describe('Asset folder id (0 = root).'),
      kind: z.enum(['IMAGE', 'BINARY', 'ALL']).default('ALL'),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($folderId:Int!,$kind:AssetKind!){ assets { list(folderId:$folderId,kind:$kind){ id filename ext kind mime fileSize metadata createdAt updatedAt } } }`,
        { folderId: a.folderId ?? 0, kind: a.kind ?? 'ALL' },
      );
      return ok(data.assets.list);
    },
  },
  {
    name: 'wiki_asset_folders',
    description: 'List sub-folders of an asset folder.',
    category: 'read',
    inputSchema: { parentFolderId: z.number().int().default(0).describe('Parent folder id (0 = root).') },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `query($parentFolderId:Int!){ assets { folders(parentFolderId:$parentFolderId){ id slug name } } }`,
        { parentFolderId: a.parentFolderId ?? 0 },
      );
      return ok(data.assets.folders);
    },
  },
  {
    name: 'wiki_asset_download',
    description:
      'Download an asset by its wiki path (e.g. "uploads/diagram.png"). Images are returned as viewable image content, text files as text, other types base64-encoded. Wiki.js enforces read:assets + path rules. NOTE: Wiki.js cannot serve assets whose extension is a page extension (by default .md/.html/.txt) — those URLs always resolve as pages.',
    category: 'read',
    inputSchema: {
      path: z.string().min(1).describe('Asset path as used in the wiki, e.g. "uploads/report.pdf".'),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(5_000_000)
        .default(1_000_000)
        .describe('Refuse files larger than this (protects the context window). Max 5 MB.'),
    },
    handler: async (a, ctx) => {
      const limit = a.maxBytes ?? 1_000_000;
      let payload: { data: Uint8Array; mime: string };
      try {
        // The limit is enforced twice: download() rejects via Content-Length
        // BEFORE buffering (the memory guard); the post-read check below is the
        // backstop for responses without a Content-Length header.
        payload = await ctx.client.download(a.path, limit);
      } catch (e) {
        if (e instanceof AssetTooLargeError) {
          return fail(`${e.message} Raise maxBytes (up to 5000000) if you really need it.`);
        }
        const msg = e instanceof Error ? e.message : String(e);
        // Wiki.js routes *.md/*.html/*.txt to the PAGE renderer, so such assets
        // 404 even when they exist — surface the real cause instead of a bare 404.
        if (/HTTP 404/.test(msg) && /\.(md|html|txt)$/i.test(a.path)) {
          return fail(
            `${msg} — Wiki.js treats .md/.html/.txt as page extensions and cannot serve assets with these endings. ` +
              `Re-upload the file with a different extension (e.g. .csv, .log) or put the content on a wiki page instead.`,
          );
        }
        throw e;
      }
      const { data, mime } = payload;
      if (data.byteLength > limit) {
        return fail(
          `Asset ${a.path} is ${data.byteLength} bytes (limit ${limit}). Raise maxBytes (up to 5000000) if you really need it.`,
        );
      }
      if (mime.startsWith('image/')) {
        return {
          content: [{ type: 'image' as const, data: Buffer.from(data).toString('base64'), mimeType: mime }],
        };
      }
      if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('yaml')) {
        return ok(new TextDecoder('utf-8').decode(data), `📄 ${a.path} (${mime}, ${data.byteLength} bytes)`);
      }
      return ok(
        { path: a.path, mime, bytes: data.byteLength, contentBase64: Buffer.from(data).toString('base64') },
        `📎 Binary asset — base64-encoded.`,
      );
    },
  },
  {
    name: 'wiki_asset_create_folder',
    description: 'Create a new asset folder.',
    category: 'write',
    inputSchema: {
      parentFolderId: z.number().int().default(0),
      slug: z.string().min(1).describe('URL-safe folder slug.'),
      name: z.string().optional(),
    },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($parentFolderId:Int!,$slug:String!,$name:String){ assets { createFolder(parentFolderId:$parentFolderId,slug:$slug,name:$name){ ${DEFAULT_RESPONSE} } } }`,
        { parentFolderId: a.parentFolderId ?? 0, slug: a.slug, name: a.name },
      );
      assertOk(data.assets.createFolder.responseResult, 'Create asset folder');
      return ok({ slug: a.slug }, '✅ Asset folder created.');
    },
  },
  {
    name: 'wiki_asset_upload',
    description:
      'Upload a file/image into an asset folder. Pass the file content base64-encoded in contentBase64.',
    category: 'write',
    inputSchema: {
      filename: z.string().min(1).describe('Target filename (Wiki.js sanitizes it).'),
      contentBase64: z.string().min(1).describe('File content, base64-encoded.'),
      folderId: z.number().int().default(0).describe('Target asset folder id (0 = root).'),
      mime: z.string().optional().describe('MIME type, e.g. "image/png". Defaults to octet-stream.'),
    },
    handler: async (a, ctx) => {
      const data = Buffer.from(a.contentBase64, 'base64');
      if (data.length === 0) return fail('contentBase64 decoded to 0 bytes — provide valid base64 file content.');
      const r = await ctx.client.upload({ filename: a.filename, data, mime: a.mime, folderId: a.folderId ?? 0 });
      if (!r.succeeded) return fail(`Upload failed: ${r.message ?? 'unknown error'}`);
      return ok({ filename: a.filename, folderId: a.folderId ?? 0, bytes: data.length }, '✅ Asset uploaded.');
    },
  },
  {
    name: 'wiki_asset_rename',
    description: 'Rename an asset (file).',
    category: 'write',
    inputSchema: { id: z.number().int(), filename: z.string().min(1) },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($id:Int!,$filename:String!){ assets { renameAsset(id:$id,filename:$filename){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id, filename: a.filename },
      );
      assertOk(data.assets.renameAsset.responseResult, 'Rename asset');
      return ok({ id: a.id, filename: a.filename }, '✅ Asset renamed.');
    },
  },
  {
    name: 'wiki_asset_delete',
    description: 'Delete an asset (file) by id.',
    category: 'delete',
    inputSchema: { id: z.number().int() },
    handler: async (a, ctx) => {
      const data = await ctx.client.request(
        `mutation($id:Int!){ assets { deleteAsset(id:$id){ ${DEFAULT_RESPONSE} } } }`,
        { id: a.id },
      );
      assertOk(data.assets.deleteAsset.responseResult, 'Delete asset');
      return ok({ id: a.id }, '🗑️ Asset deleted.');
    },
  },
  {
    name: 'wiki_assets_flush_temp',
    description: 'Flush temporary/abandoned uploads.',
    category: 'manage_system',
    inputSchema: {},
    handler: async (_a, ctx) => {
      const data = await ctx.client.request(`mutation{ assets { flushTempUploads { ${DEFAULT_RESPONSE} } } }`);
      assertOk(data.assets.flushTempUploads.responseResult, 'Flush temp uploads');
      return ok({ flushed: true }, '✅ Temp uploads flushed.');
    },
  },
];
