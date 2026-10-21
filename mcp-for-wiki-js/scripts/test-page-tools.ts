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
}

/** A tiny in-memory Wiki.js answering the queries the page tools send. */
function fakeWiki(pages: FakePage[], extra?: Responder) {
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
      return { pages: { list: pages.filter((p) => p.tags?.includes(tag)).map((p) => ({ id: p.id, path: p.path })) } };
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
