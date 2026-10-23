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

/** Wiki.js' PageViewForbidden: pages.single/singleByPath need manage:pages or delete:pages. */
export function isViewForbidden(err: unknown): boolean {
  return err instanceof Error && /not authorized to view this page/i.test(err.message);
}

/**
 * Wiki.js' history/version resolvers dereference the page before checking that it
 * exists, so an unknown page id surfaces as this TypeError (verified against 2.5).
 * Rethrow it as the not-found error every other page tool gives.
 */
export function rethrowMissingPage(err: unknown, id: number): never {
  if (err instanceof Error && /cannot read properties of undefined \(reading 'path'\)/i.test(err.message)) {
    throw new Error(`No page with id ${id}`);
  }
  throw err;
}

export interface ListedPage {
  id: number;
  path: string;
  locale: string;
}

/**
 * Find a page by id, or by path+locale, via pages.list — the only page lookup Wiki.js
 * answers with plain read:pages (audit A-01). Without an id the list is scoped to the locale.
 */
export async function findListedPage(
  ctx: WikiContext,
  a: { id: number } | { path: string; locale: string },
): Promise<ListedPage | null> {
  const byId = 'id' in a;
  const data = await ctx.client.request<{ pages: { list: ListedPage[] } }>(LIST_ALL_PATHS, {
    locale: byId ? undefined : a.locale,
  });
  return data.pages.list.find((p) => (byId ? p.id === a.id : p.path === a.path)) ?? null;
}

/**
 * singleByPath first: one row, matched by the database (collation-aware). Only when
 * Wiki.js refuses it (no manage:pages, A-01) fall back to scanning the locale's list.
 */
export async function resolvePathToId(ctx: WikiContext, path: string, locale: string): Promise<number | null> {
  try {
    const data = await ctx.client.request<{ pages: { singleByPath: { id: number } | null } }>(
      `query($path:String!,$locale:String!){ pages { singleByPath(path:$path,locale:$locale){ id } } }`,
      { path, locale },
    );
    return data.pages.singleByPath?.id ?? null;
  } catch (err) {
    if (!isViewForbidden(err)) throw err;
    return (await findListedPage(ctx, { path, locale }))?.id ?? null;
  }
}

/** The current page as pages.conflictLatest returns it (tags as plain strings). */
export interface LatestPage {
  id: number;
  path: string;
  locale: string;
  title: string;
  description: string;
  isPublished: boolean;
  content: string;
  tags: string[];
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Current page content for users WITHOUT manage:pages (audit A-01). Wiki.js answers
 * conflictLatest with write:pages; it lacks editor, isPrivate, scripts and render.
 * Throws Wiki.js' own error for an unknown id.
 */
export async function fetchLatestPage(ctx: WikiContext, id: number): Promise<LatestPage> {
  const data = await ctx.client.request<{ pages: { conflictLatest: LatestPage } }>(
    `query($id:Int!){ pages { conflictLatest(id:$id){ id path locale title description isPublished content tags authorName createdAt updatedAt } } }`,
    { id },
  );
  return data.pages.conflictLatest;
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
