/**
 * Offline tests for page tool handlers against a stubbed Wiki.js client (no network):
 *  - wiki_page_update preserves page CSS/JS when they are omitted (audit F-03)
 *  - wiki_page_update rejects an empty "find" edit (audit F-05)
 *  - wiki_pages_list hides blocked pages even when filtering by another tag (audit F-04)
 *  - re-audit 2026-10-21: bulk delete targets/cap/preview (R-06), guardrail on
 *    render/comments/tree/links + fresh blocked set for deletes (R-27), move locale
 *    (R-29), delete locale (R-30), truncated write-back (R-31), not-found errors
 *    (R-35), size limits (R-46)
 * Run: npm run test:pages
 */
process.env.WIKIJS_BLOCKED_TAGS = 'kein-ki';

export {}; // module scope — keeps `pass`/`failed` from colliding with the other test scripts

import { z } from 'zod';
import type { WikiContext } from '../lib/context';
import type { ToolDef } from '../lib/tools/types';
import { basePolicyFromEnv } from '../lib/permissions';

let pass = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log('ok  -', name);
  } else {
    failed++;
    console.log('FAIL-', name);
  }
}

type Responder = (query: string, vars: Record<string, unknown>) => unknown;

// Handlers that gate individual parameters (scripts, groups) consult ctx.policy;
// these tests are about tool logic, so the stub runs with the full-rights role.
const fullPolicy = basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'systemadmin' });

function stubCtx(respond: Responder, credentialKey: string): WikiContext {
  return {
    policy: fullPolicy,
    client: { request: async (q: string, v: Record<string, unknown> = {}) => respond(q, v) },
    baseUrl: 'https://wiki.example.org',
    hasToken: true,
    credentialKey,
  } as unknown as WikiContext;
}

async function main(): Promise<void> {
  const { pageTools } = await import('../lib/tools/pages/index');
  const tool = (name: string): ToolDef => pageTools.find((t) => t.name === name)!;

  // ---- F-03: omitted scriptCss/scriptJs are carried over -------------------
  const update = tool('wiki_page_update');
  let sent: Record<string, unknown> = {};
  const updateCtx = stubCtx((q, v) => {
    if (q.includes('single(id:$id)')) {
      return {
        pages: {
          single: {
            path: 'docs/a', locale: 'de', title: 'A', description: '', editor: 'markdown',
            isPublished: true, isPrivate: false, content: 'old', tags: [{ tag: 'docs' }],
            scriptCss: 'body{color:red}', scriptJs: 'console.log(1)',
          },
        },
      };
    }
    sent = v;
    return { pages: { update: { responseResult: { succeeded: true }, page: { id: 1 } } } };
  }, 'update');
  await update.handler({ id: 1, content: 'new' }, updateCtx);
  check('update keeps existing scriptCss when omitted', sent.scriptCss === 'body{color:red}');
  check('update keeps existing scriptJs when omitted', sent.scriptJs === 'console.log(1)');
  await update.handler({ id: 1, content: 'new', scriptCss: '' }, updateCtx);
  check('update still lets the caller clear scriptCss explicitly', sent.scriptCss === '');

  // ---- F-05: empty "find" is rejected by the input schema -------------------
  const schema = z.object(update.inputSchema);
  check(
    'update rejects edits with an empty "find"',
    !schema.safeParse({ id: 1, edits: [{ find: '', replace: 'x' }] }).success,
  );
  check('update accepts a normal edit', schema.safeParse({ id: 1, edits: [{ find: 'a', replace: 'b' }] }).success);

  // ---- F-04: tag-filtered list must not leak blocked pages ------------------
  // Wiki.js returns only the MATCHING tags when list() is filtered by tags, so a
  // page tagged [public, kein-ki] comes back as tags:["public"].
  const list = tool('wiki_pages_list');
  const listCtx = stubCtx((q, v) => {
    const tags = (v.tags as string[] | undefined) ?? [];
    if (!q.includes('orderBy')) {
      // blockedPageSets() lookup: pages carrying the blocked tag
      return { pages: { list: tags.includes('kein-ki') ? [{ id: 5, path: 'intern/geheim' }] : [] } };
    }
    return {
      pages: {
        list: [
          { id: 5, path: 'intern/geheim', title: 'Geheim', tags: ['public'] },
          { id: 6, path: 'docs/ok', title: 'Ok', tags: ['public'] },
        ],
      },
    };
  }, 'list');
  const res = await list.handler({ tags: ['public'] }, listCtx);
  const text = (res.content[0] as { text: string }).text;
  check('tag-filtered list hides the blocked page', !text.includes('Geheim'));
  check('tag-filtered list keeps unblocked pages', text.includes('docs/ok'));

  await reauditPageTests();

  if (failed === 0) {
    console.log(`\n${pass} page-tool assertions passed.`);
  } else {
    console.log(`\n${failed} FAILED (of ${pass + failed}).`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Re-audit 2026-10-21: R-06, R-27, R-29, R-30, R-31, R-35, R-46
// ---------------------------------------------------------------------------

interface FakePage {
  id: number;
  path: string;
  locale: string;
  title?: string;
  tags?: string[];
  content?: string;
  render?: string;
  publishStartDate?: string;
  publishEndDate?: string;
}

/**
 * A tiny in-memory Wiki.js answering the queries the page tools send.
 * `forbidSingle` mimics a user without manage:pages (A-01): pages.single and
 * pages.singleByPath are refused, conflictLatest (write:pages) still answers.
 */
function fakeWiki(pages: FakePage[], extra?: Responder, opts: { forbidSingle?: boolean } = {}) {
  const deleted: number[] = [];
  const mutations: Array<{ q: string; v: Record<string, unknown> }> = [];
  const queries: string[] = [];
  const withTagObjects = (p: FakePage) => ({ ...p, tags: (p.tags ?? []).map((tag) => ({ tag })) });
  const respond: Responder = (q, v) => {
    queries.push(q);
    const x = extra?.(q, v);
    if (x !== undefined) return x;
    if (q.includes('list(tags:$tags)')) {
      const tag = (v.tags as string[])[0];
      return { pages: { list: pages.filter((p) => p.tags?.includes(tag)).map((p) => ({ id: p.id, path: p.path, locale: p.locale })) } };
    }
    if (q.includes('list(locale:$locale)')) {
      return {
        pages: {
          list: pages
            .filter((p) => !v.locale || p.locale === v.locale)
            .map(({ id, path, locale, title }) => ({ id, path, locale, title })),
        },
      };
    }
    if (q.startsWith('mutation')) {
      mutations.push({ q, v });
      if (q.includes('delete(id:$id)')) deleted.push(v.id as number);
      const field = /pages \{ (\w+)\(/.exec(q)?.[1] ?? 'unknown';
      return { pages: { [field]: { responseResult: { succeeded: true }, page: { id: v.id } } } };
    }
    if (opts.forbidSingle && /\bsingle(ByPath)?\(/.test(q)) {
      throw new Error('You are not authorized to view this page.');
    }
    if (q.includes('conflictLatest(')) {
      const p = pages.find((pg) => pg.id === v.id);
      if (!p) throw new Error('This page does not exist.');
      return { pages: { conflictLatest: { ...p, content: p.content ?? '', description: '', isPublished: true, tags: p.tags ?? [] } } };
    }
    if (q.includes('singleByPath')) {
      const p = pages.find((pg) => pg.path === v.path && pg.locale === v.locale);
      return { pages: { singleByPath: p ? withTagObjects(p) : null } };
    }
    if (q.includes('single(id:$id)')) {
      const p = pages.find((pg) => pg.id === v.id);
      return { pages: { single: p ? withTagObjects(p) : null } };
    }
    return {};
  };
  return { respond, deleted, mutations, queries };
}

async function outcome(t: ToolDef, args: Record<string, unknown>, ctx: WikiContext) {
  try {
    const r = await t.handler(args, ctx);
    return { isError: r.isError === true, text: r.content.map((c) => (c as { text?: string }).text ?? '').join('\n') };
  } catch (e) {
    return { isError: true, text: e instanceof Error ? e.message : String(e) };
  }
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b).join(',');

async function reauditPageTests(): Promise<void> {
  const { allTools } = await import('../lib/tools/index');
  const { clearBlockedIdCache, blockedPageSets } = await import('../lib/guardrails');
  const { truncateContent } = await import('../lib/wikijs/format');
  const { MCP_BODY_LIMIT } = await import('../lib/body-limit');
  const tool = (name: string): ToolDef => allTools.find((t) => t.name === name)!;
  const batch = tool('wiki_pages_delete_batch');
  const tree = tool('wiki_pages_delete_tree');

  const base = (): FakePage[] => [
    { id: 1, path: 'drafts/a', locale: 'en' },
    { id: 2, path: 'drafts/sub/b', locale: 'en' },
    { id: 3, path: 'other/c', locale: 'en' },
    { id: 4, path: 'drafts/a', locale: 'de' },
  ];

  // ---- R-06: "*" stays in one segment, "**" crosses -------------------------
  let w = fakeWiki(base());
  await outcome(batch, { pathPattern: 'drafts/*', locale: 'en' }, stubCtx(w.respond, 'r06a'));
  check('R-06: pathPattern "drafts/*" deletes only direct children', sorted(w.deleted) === '1');
  w = fakeWiki(base());
  await outcome(batch, { pathPattern: 'drafts/**', locale: 'en' }, stubCtx(w.respond, 'r06b'));
  check('R-06: pathPattern "drafts/**" deletes any depth', sorted(w.deleted) === '1,2');

  // ---- R-30: locale scopes batch and tree delete -----------------------------
  w = fakeWiki(base());
  await outcome(batch, { pathPattern: 'drafts/*', locale: 'de' }, stubCtx(w.respond, 'r30a'));
  check('R-30: batch pathPattern honours locale "de"', sorted(w.deleted) === '4');
  w = fakeWiki(base());
  await outcome(tree, { rootPath: 'drafts', mode: 'children_only', locale: 'de' }, stubCtx(w.respond, 'r30b'));
  check('R-30: tree delete honours locale "de"', sorted(w.deleted) === '4');
  w = fakeWiki(base());
  await outcome(tree, { rootPath: 'drafts', mode: 'children_only', locale: 'en' }, stubCtx(w.respond, 'r30c'));
  check('R-30: tree delete in "en" leaves the "de" page alone', sorted(w.deleted) === '1,2');
  check('R-30: tree delete schema has a locale', 'locale' in tree.inputSchema);

  // ---- R-06: cap without force ------------------------------------------------
  const bulk = (): FakePage[] => Array.from({ length: 60 }, (_, i) => ({ id: 100 + i, path: `bulk/p${i}`, locale: 'en' }));
  w = fakeWiki(bulk());
  let r = await outcome(batch, { pathPattern: 'bulk/*', locale: 'en' }, stubCtx(w.respond, 'cap1'));
  check('R-06: 60 batch targets without force -> refused, nothing deleted', r.isError && w.deleted.length === 0 && r.text.includes('60'));
  w = fakeWiki(bulk());
  await outcome(batch, { pathPattern: 'bulk/*', locale: 'en', force: true }, stubCtx(w.respond, 'cap2'));
  check('R-06: 60 batch targets with force -> all deleted', w.deleted.length === 60);
  w = fakeWiki(bulk());
  r = await outcome(tree, { rootPath: 'bulk', mode: 'children_only', locale: 'en' }, stubCtx(w.respond, 'cap3'));
  check('R-06: 60 tree targets without force -> refused, nothing deleted', r.isError && w.deleted.length === 0);
  w = fakeWiki(bulk());
  await outcome(tree, { rootPath: 'bulk', mode: 'children_only', locale: 'en', force: true }, stubCtx(w.respond, 'cap4'));
  check('R-06: 60 tree targets with force -> all deleted', w.deleted.length === 60);

  // ---- R-06: preview hook resolves the real targets ---------------------------
  type Preview = { count?: number; targets?: string[] };
  w = fakeWiki(base());
  const pv = (await batch.preview?.({ pathPattern: 'drafts/**', locale: 'en' }, stubCtx(w.respond, 'pv1'))) as Preview | undefined;
  check(
    'R-06: batch preview lists count + paths and deletes nothing',
    pv?.count === 2 && !!pv.targets?.some((t) => t.includes('drafts/sub/b')) && w.deleted.length === 0,
  );
  w = fakeWiki(base());
  const pvt = (await tree.preview?.({ rootPath: 'drafts', mode: 'include_root', locale: 'en' }, stubCtx(w.respond, 'pv2'))) as Preview | undefined;
  check('R-06: tree preview lists count + paths and deletes nothing', pvt?.count === 2 && w.deleted.length === 0);

  // ---- Review 2026-10-21 #1: pathPattern length is bounded --------------------
  const batchSchema = z.object(batch.inputSchema);
  check('#1: pathPattern over 512 chars is rejected by the schema', !batchSchema.safeParse({ pathPattern: 'a*'.repeat(257) }).success);
  check('#1: pathPattern of 512 chars is accepted', batchSchema.safeParse({ pathPattern: 'a*'.repeat(256) }).success);

  // ---- Review 2026-10-21 #8: pathPattern is normalized like paths ---------------
  w = fakeWiki(base());
  await outcome(batch, { pathPattern: '/drafts/*/', locale: 'en' }, stubCtx(w.respond, 'n8'));
  check('#8: pathPattern "/drafts/*/" matches like "drafts/*"', sorted(w.deleted) === '1');

  // ---- Review 2026-10-21 #3: expectedCount pins the previewed target set -------
  const growing = base();
  w = fakeWiki(growing);
  const pv3 = (await batch.preview?.({ pathPattern: 'drafts/**', locale: 'en' }, stubCtx(w.respond, 'e3a'))) as { count?: number; note?: string } | undefined;
  check('#3: preview tells how to pin the count', pv3?.count === 2 && /expectedCount/.test(JSON.stringify(pv3)));
  growing.push({ id: 20, path: 'drafts/new', locale: 'en' }); // appears between dry run and confirm
  r = await outcome(batch, { pathPattern: 'drafts/**', locale: 'en', expectedCount: 2 }, stubCtx(w.respond, 'e3b'));
  check('#3: batch with a stale expectedCount -> refused, nothing deleted', r.isError && w.deleted.length === 0 && /expectedCount/.test(r.text) && r.text.includes('3'));
  r = await outcome(batch, { pathPattern: 'drafts/**', locale: 'en', expectedCount: 3 }, stubCtx(w.respond, 'e3c'));
  check('#3: batch with a matching expectedCount deletes', !r.isError && sorted(w.deleted) === '1,2,20');
  w = fakeWiki(base());
  r = await outcome(tree, { rootPath: 'drafts', mode: 'include_root', locale: 'en', expectedCount: 5 }, stubCtx(w.respond, 'e3d'));
  check('#3: tree with a stale expectedCount -> refused, nothing deleted', r.isError && w.deleted.length === 0);
  check('#3: both bulk deletes document expectedCount', /expectedCount/.test(batch.description) && /expectedCount/.test(tree.description));

  // ---- R-35: unresolvable batch paths are reported ---------------------------
  w = fakeWiki(base());
  r = await outcome(batch, { paths: ['missing/x', 'drafts/a'], locale: 'en' }, stubCtx(w.respond, 'r35a'));
  check('R-35: batch reports unresolved paths', /notFound/.test(r.text) && r.text.includes('missing/x') && sorted(w.deleted) === '1');

  // ---- R-27: delete paths use a FRESH blocked-id set --------------------------
  const tagLater: FakePage[] = [{ id: 9, path: 'x/y', locale: 'en', tags: [] }];
  w = fakeWiki(tagLater);
  const freshCtx = stubCtx(w.respond, 'fresh');
  clearBlockedIdCache();
  await blockedPageSets(freshCtx); // a read primes the cache: nothing blocked yet
  tagLater[0].tags = ['kein-ki']; // page gets the guardrail tag a moment later
  await outcome(batch, { ids: [9] }, freshCtx);
  check('R-27: batch delete ignores a stale cached blocked set', w.deleted.length === 0);
  await outcome(tree, { rootPath: 'x', mode: 'children_only', locale: 'en' }, freshCtx);
  check('R-27: tree delete ignores a stale cached blocked set', w.deleted.length === 0);

  // ---- R-27: render, comments, tree, links respect the tag guardrail ---------
  const secret: FakePage[] = [
    { id: 5, path: 'intern/geheim', locale: 'en', title: 'Geheim', tags: ['kein-ki'] },
    { id: 6, path: 'docs/ok', locale: 'en', title: 'Ok' },
  ];
  w = fakeWiki(secret);
  r = await outcome(tool('wiki_page_render'), { id: 5 }, stubCtx(w.respond, 'g1'));
  check('R-27: render of a blocked page is refused before the mutation', r.isError && w.mutations.length === 0);

  w = fakeWiki(secret);
  r = await outcome(tool('wiki_comments_list'), { path: 'intern/geheim', locale: 'en' }, stubCtx(w.respond, 'g2'));
  check('R-27: comments of a blocked page are refused', r.isError && !w.queries.some((q) => q.includes('comments {')));
  // Review 2026-10-21 #4: MySQL/MariaDB/MSSQL collations compare case-, accent- and
  // trailing-space-insensitively, so these variants reach the blocked page upstream.
  for (const variant of ['intern/geheim ', ' INTERN/Geheim', 'intern/gehéim', '/intern/geheim/']) {
    w = fakeWiki(secret);
    r = await outcome(tool('wiki_comments_list'), { path: variant, locale: 'en' }, stubCtx(w.respond, `g2-${variant}`));
    check(`#4: comments of "${variant}" (collation variant) are refused`, r.isError && !w.queries.some((q) => q.includes('comments {')));
  }
  w = fakeWiki(secret, (q) => (q.includes('comments {') ? { comments: { list: [] } } : undefined));
  r = await outcome(tool('wiki_comments_list'), { path: 'docs/ok', locale: 'en' }, stubCtx(w.respond, 'g2-ok'));
  check('#4: comments of an unblocked page still load', !r.isError && w.queries.some((q) => q.includes('comments {')));
  const accented: FakePage[] = [{ id: 8, path: 'intern/Gehéim', locale: 'en', title: 'Akzent', tags: ['kein-ki'] }];
  w = fakeWiki(accented, (q) =>
    q.includes('tree(') ? { pages: { tree: [{ id: 1, path: 'intern/gehéim', title: 'Akzent', pageId: 99, isFolder: false }] } } : undefined,
  );
  r = await outcome(tool('wiki_pages_tree'), { path: '', locale: 'en' }, stubCtx(w.respond, 'g4-accent'));
  check('#4: tree still hides an accented blocked page by path (same normalization)', !r.text.includes('Akzent'));

  w = fakeWiki(secret);
  r = await outcome(tool('wiki_comment_create'), { pageId: 5, content: 'hi' }, stubCtx(w.respond, 'g3'));
  check('R-27: commenting on a blocked page is refused', r.isError && w.mutations.length === 0);

  w = fakeWiki(secret, (q) =>
    q.includes('tree(')
      ? {
          pages: {
            tree: [
              { id: 1, path: 'intern/geheim', title: 'Geheim', pageId: 5, isFolder: false },
              { id: 2, path: 'docs/ok', title: 'Ok', pageId: 6, isFolder: false },
              { id: 3, path: 'intern', title: 'intern', pageId: null, isFolder: true },
            ],
          },
        }
      : undefined,
  );
  r = await outcome(tool('wiki_pages_tree'), { path: '', locale: 'en' }, stubCtx(w.respond, 'g4'));
  check('R-27: tree hides blocked pages', !r.text.includes('Geheim') && r.text.includes('docs/ok') && r.text.includes('"intern"'));

  w = fakeWiki(secret, (q) =>
    q.includes('links(')
      ? {
          pages: {
            links: [
              { id: 5, path: 'en/intern/geheim', title: 'Geheim', links: [] },
              { id: 6, path: 'en/docs/ok', title: 'Ok', links: ['en/intern/geheim', 'en/docs/x'] },
            ],
          },
        }
      : undefined,
  );
  r = await outcome(tool('wiki_pages_links'), { locale: 'en' }, stubCtx(w.respond, 'g5'));
  check('R-27: links hide blocked pages and links to them', !/geheim/i.test(r.text) && r.text.includes('en/docs/x'));

  // ---- R-29: move keeps the source locale -----------------------------------
  const move = tool('wiki_page_move');
  const dePage = (): FakePage[] => [{ id: 7, path: 'seite', locale: 'de' }];
  const moveLocale = (wk: ReturnType<typeof fakeWiki>) => wk.mutations.find((m) => m.q.includes('move('))?.v.destinationLocale;
  w = fakeWiki(dePage());
  await outcome(move, { id: 7, destinationPath: 'neu' }, stubCtx(w.respond, 'mv1'));
  check('R-29: move by id without destinationLocale keeps "de"', moveLocale(w) === 'de');
  w = fakeWiki(dePage());
  await outcome(move, { path: 'seite', locale: 'de', destinationPath: 'neu' }, stubCtx(w.respond, 'mv2'));
  check('R-29: move by path without destinationLocale keeps "de"', moveLocale(w) === 'de');
  w = fakeWiki(dePage());
  await outcome(move, { id: 7, destinationPath: 'neu', destinationLocale: 'en' }, stubCtx(w.respond, 'mv3'));
  check('R-29: explicit destinationLocale still wins', moveLocale(w) === 'en');
  check(
    'R-29: schema no longer defaults destinationLocale to "en"',
    z.object(move.inputSchema).parse({ id: 7, destinationPath: 'x' }).destinationLocale === undefined,
  );

  // ---- R-31: truncated content is never written back -------------------------
  const truncated = truncateContent({ content: 'x'.repeat(50) }, 10)!.content!;
  w = fakeWiki([{ id: 1, path: 'docs/a', locale: 'en', content: 'old' }]);
  r = await outcome(tool('wiki_page_update'), { id: 1, content: truncated }, stubCtx(w.respond, 't1'));
  check('R-31: update with the truncation notice is refused', r.isError && w.mutations.length === 0 && /truncat/i.test(r.text));
  w = fakeWiki([]);
  r = await outcome(tool('wiki_page_create'), { path: 'docs/copy', title: 'C', content: truncated }, stubCtx(w.respond, 't2'));
  check('R-31: create with the truncation notice is refused', r.isError && w.mutations.length === 0);

  // ---- R-35: "not found" is an error ------------------------------------------
  const get = tool('wiki_page_get');
  w = fakeWiki([]);
  check('R-35: page_get unknown id -> isError', (await outcome(get, { id: 999 }, stubCtx(w.respond, 'nf1'))).isError);
  check('R-35: page_get unknown path -> isError', (await outcome(get, { path: 'nope', locale: 'en' }, stubCtx(w.respond, 'nf2'))).isError);

  // ---- R-46: size limits ------------------------------------------------------
  w = fakeWiki([{ id: 1, path: 'docs/a', locale: 'en', content: 'c', render: 'r'.repeat(500) }]);
  r = await outcome(get, { id: 1, includeRender: true, maxContentChars: 100 }, stubCtx(w.respond, 's1'));
  check('R-46: rendered HTML is truncated like content', !r.text.includes('r'.repeat(101)) && /truncated/i.test(r.text));
  w = fakeWiki([{ id: 1, path: 'docs/a', locale: 'en' }], (q) =>
    q.includes('version(pageId') ? { pages: { version: { content: 'v'.repeat(150_000), tags: [] } } } : undefined,
  );
  r = await outcome(tool('wiki_page_version'), { pageId: 1, versionId: 2 }, stubCtx(w.respond, 's2'));
  check('R-46: historical version content is truncated', r.text.length < 120_000 && /truncated/i.test(r.text));
  check('R-46: page_version accepts maxContentChars', 'maxContentChars' in tool('wiki_page_version').inputSchema);
  const listSchema = z.object(tool('wiki_pages_list').inputSchema);
  check('R-46: pages_list limit has a maximum', !listSchema.safeParse({ limit: 1_000_000 }).success && listSchema.safeParse({ limit: 50 }).success);
  const histSchema = z.object(tool('wiki_page_history').inputSchema);
  check('R-46: history offsetSize has a maximum', !histSchema.safeParse({ id: 1, offsetSize: 1_000_000 }).success && histSchema.safeParse({ id: 1, offsetSize: 50 }).success);

  await a01TeamUserTests(tool);
  await phase1FollowUpTests(tool);
  await s4Tests(tool);

  const upload = tool('wiki_asset_upload');
  const uploads: number[] = [];
  const upCtx = {
    client: {
      request: async () => ({}),
      upload: async (o: { data: Uint8Array }) => {
        uploads.push(o.data.length);
        return { succeeded: true };
      },
    },
    baseUrl: 'https://wiki.example.org',
    hasToken: true,
    credentialKey: 'up',
  } as unknown as WikiContext;
  const upSchema = z.object(upload.inputSchema);
  check('R-46: contentBase64 longer than the /mcp body limit is rejected by the schema', !upSchema.safeParse({ filename: 'a.bin', contentBase64: 'A'.repeat(MCP_BODY_LIMIT + 4) }).success);
  r = await outcome(upload, { filename: 'a.bin', contentBase64: '@@not base64!!', folderId: 0 }, upCtx);
  check('R-46: invalid base64 is refused before uploading', r.isError && uploads.length === 0);
  r = await outcome(upload, { filename: 'a.bin', contentBase64: 'aGVsbG8=', folderId: 0 }, upCtx);
  check('R-46: valid base64 still uploads', !r.isError && uploads[0] === 5);
}

// ---------------------------------------------------------------------------
// Audit 2026-10-23: A-01 (tools without manage:pages), A-07 (edits result bound)
// ---------------------------------------------------------------------------

async function a01TeamUserTests(tool: (name: string) => ToolDef): Promise<void> {
  const { MCP_BODY_LIMIT } = await import('../lib/body-limit');
  const team = (): FakePage[] => [
    { id: 1, path: 'team/a', locale: 'de', title: 'A', content: 'Hallo Welt', tags: ['docs'] },
    { id: 5, path: 'intern/geheim', locale: 'en', title: 'Geheim', content: 'x', tags: ['kein-ki'] },
  ];
  const teamWiki = (extra?: Responder) => fakeWiki(team(), extra, { forbidSingle: true });
  const sentSingle = (wk: ReturnType<typeof fakeWiki>) => wk.queries.some((q) => /\bsingle(ByPath)?\(/.test(q));
  const mutation = (wk: ReturnType<typeof fakeWiki>, field: string) => wk.mutations.find((m) => m.q.includes(`${field}(`));

  let w = teamWiki();
  let r = await outcome(tool('wiki_page_update'), { id: 1, edits: [{ find: 'Welt', replace: 'Team' }] }, stubCtx(w.respond, 'a01u'));
  const upd = mutation(w, 'update')?.v;
  check('A-01: update without manage:pages succeeds', !r.isError && upd?.content === 'Hallo Team');
  check(
    'A-01: update keeps path/locale/title/tags from conflictLatest',
    upd?.path === 'team/a' && upd?.locale === 'de' && upd?.title === 'A' && JSON.stringify(upd?.tags) === '["docs"]',
  );
  check('A-01: update without readable scripts leaves them to Wiki.js (not sent)', upd?.scriptCss == null && upd?.scriptJs == null);

  w = teamWiki();
  r = await outcome(tool('wiki_page_update'), { id: 5, content: 'neu' }, stubCtx(w.respond, 'a01ub'));
  check('A-01: update of a blocked page is still refused', r.isError && /blocked tag/.test(r.text) && !mutation(w, 'update'));

  w = teamWiki();
  r = await outcome(tool('wiki_page_get'), { id: 1 }, stubCtx(w.respond, 'a01g1'));
  check('A-01: page_get by id without manage:pages returns the content', !r.isError && r.text.includes('Hallo Welt'));
  w = teamWiki();
  r = await outcome(tool('wiki_page_get'), { path: 'team/a', locale: 'de' }, stubCtx(w.respond, 'a01g2'));
  check('A-01: page_get by path without manage:pages returns the content', !r.isError && r.text.includes('Hallo Welt'));
  w = teamWiki();
  r = await outcome(tool('wiki_page_get'), { path: 'intern/geheim', locale: 'en' }, stubCtx(w.respond, 'a01g3'));
  check('A-01: page_get of a blocked page by path is refused', r.isError && /blocked tag/.test(r.text));
  w = teamWiki();
  r = await outcome(tool('wiki_page_get'), { path: 'fehlt', locale: 'de' }, stubCtx(w.respond, 'a01g4'));
  check('A-01: page_get of an unknown path is an error', r.isError);

  const history = (q: string) => (q.includes('history(id') ? { pages: { history: { trail: [], total: 1 } } } : undefined);
  w = teamWiki(history);
  r = await outcome(tool('wiki_page_history'), { id: 1 }, stubCtx(w.respond, 'a01h1'));
  check('A-01: history without manage:pages succeeds, no pages.single', !r.isError && !sentSingle(w));
  w = teamWiki(history);
  r = await outcome(tool('wiki_page_history'), { id: 5 }, stubCtx(w.respond, 'a01h2'));
  check('A-01: history of a blocked page is refused', r.isError && /blocked tag/.test(r.text));

  w = teamWiki();
  r = await outcome(tool('wiki_page_move'), { id: 1, destinationPath: 'team/b' }, stubCtx(w.respond, 'a01m1'));
  check('A-01: move by id keeps the page locale without pages.single', !r.isError && mutation(w, 'move')?.v.destinationLocale === 'de' && !sentSingle(w));
  w = teamWiki();
  r = await outcome(tool('wiki_page_move'), { path: 'team/a', locale: 'de', destinationPath: 'team/b' }, stubCtx(w.respond, 'a01m2'));
  check(
    'A-01: move by path falls back to the page list when singleByPath is refused',
    !r.isError && mutation(w, 'move')?.v.id === 1 && w.queries.some((q) => q.includes('list(locale:$locale)')),
  );

  for (const [name, args] of [
    ['wiki_page_render', { id: 5 }],
    ['wiki_page_convert', { id: 5, editor: 'html' }],
    ['wiki_page_restore', { pageId: 5, versionId: 1 }],
    ['wiki_page_version', { pageId: 5, versionId: 1 }],
    ['wiki_page_move', { id: 5, destinationPath: 'x' }],
  ] as const) {
    w = teamWiki();
    r = await outcome(tool(name), { ...args }, stubCtx(w.respond, `a01-${name}`));
    check(`A-01: ${name} of a blocked page is refused without pages.single`, r.isError && /blocked tag/.test(r.text) && !sentSingle(w) && w.mutations.length === 0);
  }

  // Only Wiki.js' "not authorized to view" triggers the fallback — other errors surface.
  w = fakeWiki(team(), (q) => {
    if (/\bsingle\(/.test(q)) throw new Error('Wiki.js request timed out after 30000 ms.');
    return undefined;
  });
  r = await outcome(tool('wiki_page_update'), { id: 1, content: 'neu' }, stubCtx(w.respond, 'a01e'));
  check('A-01: other errors of pages.single are not masked by the fallback', r.isError && /timed out/.test(r.text) && !w.queries.some((q) => q.includes('conflictLatest(')));

  // Users who CAN use singleByPath (manage:pages) still resolve paths through it, not the list.
  w = fakeWiki(team());
  r = await outcome(tool('wiki_page_move'), { path: 'team/a', locale: 'de', destinationPath: 'team/b' }, stubCtx(w.respond, 'a01p'));
  check('A-01: path lookup with manage:pages uses singleByPath, no full page list', !r.isError && mutation(w, 'move')?.v.id === 1 && !w.queries.some((q) => q.includes('list(locale:$locale)')));

  // ---- A-07: the edits result is bounded before it is built --------------------
  const big = 'y'.repeat(1024 * 1024);
  w = fakeWiki([{ id: 1, path: 'docs/a', locale: 'en', content: 'x'.repeat(8) }]);
  r = await outcome(tool('wiki_page_update'), { id: 1, edits: [{ find: 'x', replace: big }] }, stubCtx(w.respond, 'a07a'));
  check('A-07: edits growing the page past the limit are refused', r.isError && /limit/i.test(r.text) && w.mutations.length === 0);
  w = fakeWiki([{ id: 1, path: 'docs/a', locale: 'en', content: 'x' }]);
  r = await outcome(tool('wiki_page_update'), { id: 1, edits: [{ find: 'x', replace: 'z'.repeat(MCP_BODY_LIMIT) }] }, stubCtx(w.respond, 'a07b'));
  check('A-07: an edit result exactly at the limit is allowed', !r.isError && w.mutations.length === 1);
}

// ---------------------------------------------------------------------------
// Follow-ups found while fixing audit 2026-10-23 phase 1
async function phase1FollowUpTests(tool: (name: string) => ToolDef): Promise<void> {
  // Wiki.js crashes on history/version of an unknown page id with a TypeError
  // ("Cannot read properties of undefined (reading 'path')") — reproduced live.
  const crash = (q: string) =>
    /\bhistory\(|\bversion\(/.test(q) ?(() => { throw new Error("Cannot read properties of undefined (reading 'path')"); })() : undefined;
  let w = fakeWiki([], crash);
  let r = await outcome(tool('wiki_page_history'), { id: 999 }, stubCtx(w.respond, 'f1h'));
  check('history of an unknown id → clear "no page" error', r.isError && /no page with id 999/i.test(r.text));
  r = await outcome(tool('wiki_page_version'), { pageId: 999, versionId: 1 }, stubCtx(w.respond, 'f1v'));
  check('version of an unknown page id → clear "no page" error', r.isError && /no page with id 999/i.test(r.text));

  // Wiki.js clears publishStartDate/EndDate on every update that omits them (live-verified).
  const scheduled = { id: 1, path: 'docs/a', locale: 'en', content: 'x', publishStartDate: '2030-01-01T00:00:00.000Z', publishEndDate: '2031-01-01T00:00:00.000Z' };
  w = fakeWiki([scheduled]);
  r = await outcome(tool('wiki_page_update'), { id: 1, content: 'y' }, stubCtx(w.respond, 'f1p1'));
  const sent = w.mutations[0]?.v ?? {};
  check('update keeps the scheduled publish window', !r.isError && sent.publishStartDate === scheduled.publishStartDate && sent.publishEndDate === scheduled.publishEndDate);
  w = fakeWiki([scheduled]);
  await outcome(tool('wiki_page_update'), { id: 1, publishStartDate: '', publishEndDate: '' }, stubCtx(w.respond, 'f1p2'));
  const cleared = w.mutations[0]?.v ?? {};
  check('an explicit "" clears the publish window (no invalid date sent)', cleared.publishStartDate === undefined && cleared.publishEndDate === undefined);
  w = fakeWiki([{ id: 1, path: 'docs/a', locale: 'en', content: 'x' }]);
  await outcome(tool('wiki_page_update'), { id: 1, content: 'y' }, stubCtx(w.respond, 'f1p3'));
  const none = w.mutations[0]?.v ?? {};
  check('a page without publish window sends no dates', none.publishStartDate === undefined && none.publishEndDate === undefined);
  w = fakeWiki([scheduled], undefined, { forbidSingle: true });
  r = await outcome(tool('wiki_page_update'), { id: 1, content: 'y' }, stubCtx(w.respond, 'f1p4'));
  check('team user (no manage:pages): update works and warns that the publish window could not be read', !r.isError && /publish/i.test(r.text));
  w = fakeWiki([scheduled], undefined, { forbidSingle: true });
  await outcome(tool('wiki_page_update'), { id: 1, content: 'y', publishStartDate: '2030-01-01T00:00:00.000Z' }, stubCtx(w.respond, 'f1p5'));
  check('team user can set the publish window explicitly', w.mutations[0]?.v.publishStartDate === '2030-01-01T00:00:00.000Z');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Audit 2026-10-23 package S4: A-08, A-18, A-23, A-26, A-27
// ---------------------------------------------------------------------------
async function s4Tests(tool: (name: string) => ToolDef): Promise<void> {
  const { clearSiteLocaleCache } = await import('../lib/wikijs/site-locale');
  const mutation = (wk: ReturnType<typeof fakeWiki>, field: string) => wk.mutations.find((m) => m.q.includes(`${field}(`));

  // ---- A-08: bulk delete inputs are bounded; lookups stay linear --------------
  const batchSchema = z.object(tool('wiki_pages_delete_batch').inputSchema);
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  check('A-08: more than 1000 ids are rejected', !batchSchema.safeParse({ ids: range(1001) }).success);
  check('A-08: more than 1000 paths are rejected', !batchSchema.safeParse({ paths: range(1001).map((i) => `p${i}`) }).success);
  check('A-08: an overlong path is rejected', !batchSchema.safeParse({ paths: ['x'.repeat(513)] }).success);
  check('A-08: 1000 ids are accepted', batchSchema.safeParse({ ids: range(1000) }).success);
  const many: FakePage[] = range(3000).map((i) => ({ id: i, path: `bulk/p${i}`, locale: 'en' }));
  let w = fakeWiki(many);
  let r = await outcome(
    tool('wiki_pages_delete_batch'),
    { ids: [1, 2, 99999], paths: ['bulk/p3', '/bulk/p4/', 'bulk/missing'], locale: 'en' },
    stubCtx(w.respond, 's4a'),
  );
  check('A-08: ids and paths still resolve (found + notFound)', !r.isError && sorted(w.deleted) === '1,2,3,4' && r.text.includes('#99999') && r.text.includes('bulk/missing'));

  // ---- A-18: Wiki.js drops all tags on restore and returns none for versions --
  w = fakeWiki([{ id: 1, path: 'docs/a', locale: 'en', content: 'x', tags: ['team', 'howto'] }]);
  r = await outcome(tool('wiki_page_restore'), { pageId: 1, versionId: 2 }, stubCtx(w.respond, 's4r'));
  check('A-18: restore runs and names the tags Wiki.js removed', !r.isError && mutation(w, 'restore') !== undefined && /tags/i.test(r.text) && r.text.includes('team') && r.text.includes('howto'));
  w = fakeWiki([{ id: 1, path: 'docs/a', locale: 'en', content: 'x' }]);
  r = await outcome(tool('wiki_page_restore'), { pageId: 1, versionId: 2 }, stubCtx(w.respond, 's4r2'));
  check('A-18: restore of an untagged page has no tag warning', !r.isError && !/removed/i.test(r.text));
  w = fakeWiki([{ id: 1, path: 'docs/a', locale: 'en', content: 'x' }], (q) =>
    q.includes('version(') ? { pages: { version: { versionId: 2, pageId: 1, path: 'docs/a', content: 'old' } } } : undefined,
  );
  r = await outcome(tool('wiki_page_version'), { pageId: 1, versionId: 2 }, stubCtx(w.respond, 's4v'));
  check('A-18: page_version no longer asks for the always-empty version tags', !r.isError && !w.queries.some((q) => q.includes('version(') && /\btags\b/.test(q)));

  // ---- A-23: comments of blocked pages, addressed by comment id ----------------
  const pagesWithComments: FakePage[] = [
    { id: 5, path: 'intern/geheim', locale: 'en', tags: ['kein-ki'] },
    { id: 6, path: 'docs/ok', locale: 'en' },
  ];
  const commentCalls: string[] = [];
  const comments = (q: string, v: Record<string, unknown>) => {
    if (q.includes('comments { list')) return { comments: { list: v.path === 'intern/geheim' ? [{ id: 41 }, { id: 42 }] : [{ id: 7 }] } };
    if (q.includes('comments { single')) {
      commentCalls.push('single');
      return { comments: { single: v.id === 77 ? null : { id: v.id, content: 'c' } } };
    }
    if (q.includes('comments { update')) {
      commentCalls.push('update');
      return { comments: { update: { responseResult: { succeeded: true }, render: '' } } };
    }
    if (q.includes('comments { delete')) {
      commentCalls.push('delete');
      return { comments: { delete: { responseResult: { succeeded: true } } } };
    }
    return undefined;
  };
  const commentRun = async (name: string, args: Record<string, unknown>, key: string) => {
    commentCalls.length = 0;
    const wk = fakeWiki(pagesWithComments, comments);
    return outcome(tool(name), args, stubCtx(wk.respond, key));
  };
  r = await commentRun('wiki_comment_get', { id: 41 }, 's4c1');
  check('A-23: reading a comment of a blocked page by id is refused', r.isError && commentCalls.length === 0);
  r = await commentRun('wiki_comment_update', { id: 42, content: 'x' }, 's4c2');
  check('A-23: editing a comment of a blocked page is refused', r.isError && commentCalls.length === 0);
  r = await commentRun('wiki_comment_delete', { id: 41 }, 's4c3');
  check('A-23: deleting a comment of a blocked page is refused', r.isError && commentCalls.length === 0);
  r = await commentRun('wiki_comment_get', { id: 7 }, 's4c4');
  check('A-23: a comment of an unblocked page still loads', !r.isError && commentCalls.includes('single'));
  r = await commentRun('wiki_comment_delete', { id: 7 }, 's4c5');
  check('A-23: a comment of an unblocked page can still be deleted', !r.isError && commentCalls.includes('delete'));

  // ---- A-27: an unreadable comment is an error, not ok(null) --------------------
  r = await commentRun('wiki_comment_get', { id: 77 }, 's4c6');
  check('A-27: comment_get of an unknown/unreadable id is an error', r.isError && r.text.includes('77'));

  // ---- A-26: default limits ------------------------------------------------------
  const listed = range(250).map((i) => ({ id: i, path: `list/x${i}y`, locale: 'en', title: `T${i}` }));
  let sentLimit: unknown;
  w = fakeWiki([], (q, v) => {
    if (!q.includes('orderBy')) return undefined;
    sentLimit = v.limit;
    return { pages: { list: listed.slice(0, (v.limit as number | undefined) ?? listed.length) } };
  });
  r = await outcome(tool('wiki_pages_list'), {}, stubCtx(w.respond, 's4l1'));
  check('A-26: pages_list sends a default limit of 100', sentLimit === 100);
  check('A-26: a full page of results says that more may exist', !r.isError && /limit/i.test(r.text) && r.text.includes('list/x100y') && !r.text.includes('list/x101y'));
  r = await outcome(tool('wiki_pages_list'), { limit: 500 }, stubCtx(w.respond, 's4l2'));
  check('A-26: an explicit limit wins; a short result has no note', sentLimit === 500 && !r.isError && !/more may exist/i.test(r.text));
  const links = range(600).map((i) => ({ id: i, path: `en/links/x${i}y`, title: `L${i}`, links: [] }));
  w = fakeWiki([], (q) => (q.includes('links(locale') ? { pages: { links } } : undefined));
  r = await outcome(tool('wiki_pages_links'), { locale: 'en' }, stubCtx(w.respond, 's4l3'));
  check('A-26: pages_links returns at most 500 entries by default and says so', !r.isError && r.text.includes('links/x500y') && !r.text.includes('links/x501y') && /limit/i.test(r.text));

  // ---- A-26: the default locale is the site locale, not a hard "en" --------------
  check('A-26: page_get no longer injects locale "en"', z.object(tool('wiki_page_get').inputSchema).parse({ path: 'x' }).locale === undefined);
  clearSiteLocaleCache();
  w = fakeWiki([{ id: 3, path: 'start', locale: 'de', title: 'Start', content: 'x' }], (q) =>
    q.includes('localization') ? { localization: { config: { locale: 'de' } } } : undefined,
  );
  r = await outcome(tool('wiki_page_get'), { path: 'start' }, stubCtx(w.respond, 's4loc1'));
  check('A-26: without locale, a path lookup uses the site locale', !r.isError && r.text.includes('Start'));
  clearSiteLocaleCache();
  w = fakeWiki([{ id: 3, path: 'start', locale: 'en', title: 'Start', content: 'x' }], (q) => {
    if (q.includes('localization')) throw new Error('Forbidden');
    return undefined;
  });
  r = await outcome(tool('wiki_page_get'), { path: 'start' }, stubCtx(w.respond, 's4loc2'));
  check('A-26: an unreadable site locale falls back to "en"', !r.isError && r.text.includes('Start'));
  clearSiteLocaleCache();
}
