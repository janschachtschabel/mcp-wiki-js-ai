import type { WikiContext } from '../../context';
import { DEFAULT_RESPONSE } from '../types';

export const PAGE_META_FIELDS =
  'id path title description isPrivate isPublished locale contentType createdAt updatedAt authorId authorName creatorId creatorName tags { tag title }';

/** Default soft cap on returned page content, to protect the model's context window. */
export const DEFAULT_MAX_CONTENT = 100_000;

export function singleSelection(includeContent: boolean, includeRender: boolean): string {
  // NOTE: Page.toc is declared `String` in the Wiki.js schema, but the underlying column is
  // JSON. On Postgres the driver returns a parsed array, so selecting `toc` makes GraphQL
  // throw "String cannot represent value: [...]" and fails the whole query. We therefore
  // request only `render` (the rendered HTML, which is reliable on every DB backend).
  return `${PAGE_META_FIELDS}${includeContent ? ' content editor' : ''}${includeRender ? ' render' : ''}`;
}

export const DELETE_PAGE = `mutation($id:Int!){ pages { delete(id:$id) { ${DEFAULT_RESPONSE} } } }`;
export const LIST_ALL_PATHS = `query($locale:String){ pages { list(locale:$locale) { id path locale title } } }`;

export async function resolvePathToId(ctx: WikiContext, path: string, locale: string): Promise<number | null> {
  const data = await ctx.client.request<{ pages: { singleByPath: { id: number } | null } }>(
    `query($path:String!,$locale:String!){ pages { singleByPath(path:$path,locale:$locale){ id } } }`,
    { path, locale },
  );
  return data.pages.singleByPath?.id ?? null;
}

/** Resolve a page id from either an explicit id or a path+locale pair. */
export async function requirePageId(
  ctx: WikiContext,
  a: { id?: number; path?: string; locale?: string },
): Promise<number> {
  if (a.id != null) return a.id;
  if (a.path) {
    const id = await resolvePathToId(ctx, a.path, a.locale ?? 'en');
    if (id == null) throw new Error(`No page at ${a.path} (${a.locale ?? 'en'}).`);
    return id;
  }
  throw new Error('Provide either "id" or "path".');
}
