/**
 * Offline tests for page tool handlers against a stubbed Wiki.js client (no network):
 *  - wiki_page_update preserves page CSS/JS when they are omitted (audit F-03)
 *  - wiki_page_update rejects an empty "find" edit (audit F-05)
 *  - wiki_pages_list hides blocked pages even when filtering by another tag (audit F-04)
 * Run: npm run test:pages
 */
process.env.WIKIJS_BLOCKED_TAGS = 'kein-ki';

export {}; // module scope — keeps `pass`/`failed` from colliding with the other test scripts

import { z } from 'zod';
import type { WikiContext } from '../lib/context';
import type { ToolDef } from '../lib/tools/types';

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

function stubCtx(respond: Responder, credentialKey: string): WikiContext {
  return {
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

  if (failed === 0) {
    console.log(`\n${pass} page-tool assertions passed.`);
  } else {
    console.log(`\n${failed} FAILED (of ${pass + failed}).`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
