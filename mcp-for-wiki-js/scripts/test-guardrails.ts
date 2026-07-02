/**
 * Offline tests for the tag guardrail (lib/guardrails.ts): env parsing, both
 * tag shapes Wiki.js returns, list filtering, and the blocked-id cache using a
 * stubbed WikiContext (no network).  Run: npm run test:guard
 */
process.env.WIKIJS_BLOCKED_TAGS = 'kein-ki, No-AI';

export {}; // module scope — keeps `pass`/`failed` from colliding with the other test scripts

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

async function main(): Promise<void> {
  const g = await import('../lib/guardrails');

  // ---- parsing ------------------------------------------------------------
  const tags = g.blockedTags();
  check('parses comma list, trims, lowercases', tags.has('kein-ki') && tags.has('no-ai') && tags.size === 2);
  check('empty env → empty set', g.blockedTags({}).size === 0);

  // ---- tag shapes ---------------------------------------------------------
  check('string[] shape (pages.list)', g.tagsBlocked(['intern', 'kein-ki']));
  check('object[] shape (pages.single)', g.tagsBlocked([{ tag: 'KEIN-KI', title: 'Kein KI' }]));
  check('case-insensitive match', g.tagsBlocked(['No-Ai']));
  check('unblocked tags pass', !g.tagsBlocked(['docs', 'howto']));
  check('missing tags pass', !g.tagsBlocked(undefined));

  let threw = false;
  try {
    g.assertTagsNotBlocked([{ tag: 'kein-ki' }], 'Page 7');
  } catch (e) {
    threw = e instanceof Error && e.message.includes('not available to AI agents');
  }
  check('assertTagsNotBlocked throws the uniform refusal', threw);

  // ---- list filtering -----------------------------------------------------
  const { visible, hidden } = g.filterBlockedPages([
    { id: 1, tags: ['docs'] },
    { id: 2, tags: ['kein-ki'] },
    { id: 3 },
  ]);
  check('filterBlockedPages hides blocked, keeps rest', visible.length === 2 && hidden === 1);

  // ---- blocked-id/path sets via stubbed context ------------------------------
  let calls = 0;
  const stubClient = {
    request: async (_q: string, vars: Record<string, unknown>) => {
      calls++;
      const tag = (vars.tags as string[])[0];
      return {
        pages: {
          list:
            tag === 'kein-ki'
              ? [{ id: 10, path: 'geheim/plan' }, { id: 11, path: 'Geheim/Zwei' }]
              : [{ id: 12, path: 'intern/notiz' }],
        },
      };
    },
  };
  const ctx = {
    baseUrl: 'https://stub.example',
    credentialKey: 'user-a',
    client: stubClient,
  } as unknown as import('../lib/context').WikiContext;

  g.clearBlockedIdCache();
  const sets = await g.blockedPageSets(ctx);
  check('blockedPageSets unions all blocked tags', sets.ids.has(10) && sets.ids.has(11) && sets.ids.has(12) && sets.ids.size === 3);
  check('blockedPageSets collects lowercased paths (stale-index defense)', sets.paths.has('geheim/plan') && sets.paths.has('geheim/zwei'));
  check('one upstream query per blocked tag', calls === 2);
  await g.blockedPageIds(ctx);
  check('second call is served from cache', calls === 2);

  // Cache is partitioned PER CREDENTIAL: another user must not inherit user-a's
  // permission-filtered id set (that would leak pages across permission levels).
  const ctxB = { baseUrl: 'https://stub.example', credentialKey: 'user-b', client: stubClient } as unknown as import('../lib/context').WikiContext;
  await g.blockedPageIds(ctxB);
  check('different credential does NOT share the cache', calls === 4);

  // ---- guardrail-tag self-protection ---------------------------------------
  const tagCtx = {
    baseUrl: 'https://stub.example',
    credentialKey: 'user-a',
    client: {
      request: async () => ({ pages: { tags: [{ id: 1, tag: 'kein-ki' }, { id: 2, tag: 'docs' }] } }),
    },
  } as unknown as import('../lib/context').WikiContext;
  let tagThrew = false;
  try {
    await g.assertTagIdNotBlocked(tagCtx, 1, 'Tag update');
  } catch (e) {
    tagThrew = e instanceof Error && e.message.includes('protected AI-guardrail tag');
  }
  check('renaming/deleting a guardrail tag is refused', tagThrew);
  await g.assertTagIdNotBlocked(tagCtx, 2, 'Tag update'); // must not throw
  check('other tags stay editable', true);

  // ---- guardrail off ⇒ zero upstream queries -------------------------------
  delete process.env.WIKIJS_BLOCKED_TAGS;
  g.clearBlockedIdCache();
  calls = 0;
  const none = await g.blockedPageIds(ctx);
  check('disabled guardrail: empty set, no queries', none.size === 0 && calls === 0);
  check('disabled guardrail: nothing blocked', !g.tagsBlocked(['kein-ki']));

  if (failed === 0) {
    console.log(`\n${pass} guardrail assertions passed.`);
  } else {
    console.log(`\n${failed} FAILED (of ${pass + failed}).`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
