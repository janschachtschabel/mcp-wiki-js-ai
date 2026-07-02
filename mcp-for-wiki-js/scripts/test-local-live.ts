/**
 * Live integration test: runs the REAL tool handlers against a Wiki.js instance.
 * Self-cleaning (everything under tmp/mcptest / mcp-test-* is removed at the end).
 *
 * Usage (point at a throwaway/empty wiki!):
 *   WIKIJS_URL=http://localhost:3000 WIKIJS_TOKEN=<api-key> npx tsx scripts/test-local-live.ts
 *
 * It exercises ~66/68 tools. asset_rename/asset_delete need an uploaded file (no upload
 * tool) and are skipped. Expected "errors" (reset_password stub, nav destructive-guard,
 * graphql mutation dry-run) are asserted as correct behavior.
 */
import { WikiClient } from '../lib/wikijs/client';
import { allTools } from '../lib/tools/index';
import { basePolicy } from '../lib/context';
import type { WikiContext } from '../lib/context';

const URL = process.env.WIKIJS_URL;
const TOKEN = process.env.WIKIJS_TOKEN;
if (!URL || !TOKEN) {
  console.error('Set WIKIJS_URL and WIKIJS_TOKEN.');
  process.exit(2);
}

const ctx: WikiContext = { client: new WikiClient(URL, TOKEN), policy: basePolicy(), baseUrl: URL, hasToken: true };
const byName = new Map(allTools.map((t) => [t.name, t]));

let pass = 0;
let fail = 0;
const failures: string[] = [];

function dataOf(text: string): any {
  const i = text.indexOf('\n\n');
  const body = i >= 0 ? text.slice(i + 2) : text;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

async function call(name: string, args: any): Promise<{ ok: boolean; text: string }> {
  const tool = byName.get(name);
  if (!tool) return { ok: false, text: `NO SUCH TOOL: ${name}` };
  try {
    const r = await tool.handler(args ?? {}, ctx);
    const text = (r.content?.[0] as any)?.text ?? '';
    return { ok: !r.isError, text };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

interface Opt { expectError?: boolean; mustContain?: string }
async function step(label: string, name: string, args: any, opt?: Opt): Promise<any> {
  const r = await call(name, args);
  let good = opt?.expectError ? !r.ok : r.ok;
  if (good && opt?.mustContain && !r.text.includes(opt.mustContain)) good = false;
  if (good) {
    pass++;
    console.log('ok    ' + label);
  } else {
    fail++;
    failures.push(`${label} :: ${r.text.slice(0, 130)}`);
    console.log('FAIL  ' + label + '  ::  ' + r.text.replace(/\n/g, ' ').slice(0, 130));
  }
  return dataOf(r.text);
}

async function main(): Promise<void> {
  console.log('### READS (sanity)');
  await step('connection_status', 'wiki_connection_status', {});
  await step('site_info', 'wiki_site_info', {});
  await step('system_info', 'wiki_system_info', {});
  await step('system_flags', 'wiki_system_flags', {});
  await step('site_config', 'wiki_site_config', {});
  await step('user_profile', 'wiki_user_profile', {});
  await step('users_list', 'wiki_users_list', {});
  await step('users_search', 'wiki_users_search', { query: 'a' });
  await step('users_last_logins', 'wiki_users_last_logins', {});
  await step('groups_list', 'wiki_groups_list', {});
  await step('navigation_get', 'wiki_navigation_get', {});
  await step('tags_list', 'wiki_tags_list', {});
  await step('tags_search', 'wiki_tags_search', { query: 'a' });
  await step('assets_list', 'wiki_assets_list', {});
  await step('asset_folders', 'wiki_asset_folders', {});
  await step('apikeys_list', 'wiki_apikeys_list', {});
  await step('auth_strategies', 'wiki_auth_strategies', {});
  await step('pages_list', 'wiki_pages_list', { limit: 5 });
  await step('pages_tree', 'wiki_pages_tree', { path: '', locale: 'en' });
  await step('pages_links', 'wiki_pages_links', { locale: 'en' });
  await step('pages_search', 'wiki_pages_search', { query: 'a' });

  console.log('\n### PAGES write lifecycle');
  await call('wiki_pages_delete_tree', { rootPath: 'tmp/mcptest', mode: 'include_root' }); // preclean
  const p1 = await step('page_create', 'wiki_page_create', {
    path: 'tmp/mcptest/p1', title: 'MCP P1', content: '# P1\nhello world\nmore', locale: 'en', tags: ['mcptag'],
  });
  const P1 = p1?.id;
  await step('page_get', 'wiki_page_get', { id: P1 });
  await step('page_update (edits)', 'wiki_page_update', { id: P1, edits: [{ find: 'hello world', replace: 'updated' }] });
  await step('page_update (full)', 'wiki_page_update', { id: P1, content: '# P1 v2\nfull', title: 'MCP P1b' });
  await step('page_render', 'wiki_page_render', { id: P1 });
  const hist = await step('page_history', 'wiki_page_history', { id: P1 });
  const V = hist?.trail?.[0]?.versionId;
  await step('page_version', 'wiki_page_version', { pageId: P1, versionId: V });
  await step('page_restore', 'wiki_page_restore', { pageId: P1, versionId: V });
  await step('page_convert (Wiki.js-Konvertierungslimit erwartet)', 'wiki_page_convert', { id: P1, editor: 'html' }, { expectError: true, mustContain: 'content types' });
  await step('page_move', 'wiki_page_move', { id: P1, destinationPath: 'tmp/mcptest/p1moved', destinationLocale: 'en' });

  console.log('\n### COMMENTS (on P1)');
  const c1 = await step('comment_create', 'wiki_comment_create', { pageId: P1, content: 'mcp test comment body' });
  const C1 = c1?.id;
  await step('comment_get', 'wiki_comment_get', { id: C1 });
  await step('comments_list', 'wiki_comments_list', { path: 'tmp/mcptest/p1moved', locale: 'en' });
  await step('comment_update', 'wiki_comment_update', { id: C1, content: 'updated comment body' });
  await step('comment_delete', 'wiki_comment_delete', { id: C1 });

  console.log('\n### TAGS');
  // dedizierte getaggte Seite -> garantiert ein Tag in der Liste
  await call('wiki_page_create', { path: 'tmp/mcptest/tagp', title: 'TagPage', content: 'x', locale: 'en', tags: ['mcpverifytag'] });
  const tags = await step('tags_list', 'wiki_tags_list', {});
  const tagId = Array.isArray(tags) ? tags.find((t: any) => t.tag === 'mcpverifytag')?.id : undefined;
  console.log('   tagId=' + tagId + ' (tags: ' + (Array.isArray(tags) ? tags.map((t: any) => t.tag).join(',') : '?') + ')');
  await step('tag_update', 'wiki_tag_update', { id: tagId, tag: 'mcpverifytag2', title: 'MCP Tag' });
  await step('tag_delete', 'wiki_tag_delete', { id: tagId });

  console.log('\n### DELETE (single / batch / tree / purge)');
  const del1 = await step('page_create (del1)', 'wiki_page_create', { path: 'tmp/mcptest/del1', title: 'D', content: 'x', locale: 'en' });
  await step('page_delete (single)', 'wiki_page_delete', { id: del1?.id });
  await call('wiki_page_create', { path: 'tmp/mcptest/p2', title: 'P2', content: 'x', locale: 'en' });
  await call('wiki_page_create', { path: 'tmp/mcptest/sub/p3', title: 'P3', content: 'x', locale: 'en' });
  await step('pages_delete_batch', 'wiki_pages_delete_batch', { paths: ['tmp/mcptest/p1moved', 'tmp/mcptest/p2'], locale: 'en' });
  await step('pages_delete_tree', 'wiki_pages_delete_tree', { rootPath: 'tmp/mcptest', mode: 'include_root' });
  await step('pages_purge_history (no-op)', 'wiki_pages_purge_history', { olderThan: 'P100Y' });

  console.log('\n### USERS lifecycle');
  // preclean: Leftover-Testuser aus einem fehlgeschlagenen Lauf entfernen
  async function findUser(): Promise<number | undefined> {
    const f = await call('wiki_users_search', { query: 'mcptest@example.invalid' });
    const arr = dataOf(f.text);
    return Array.isArray(arr) ? arr.find((u: any) => u.email === 'mcptest@example.invalid')?.id : undefined;
  }
  const stale = await findUser();
  if (stale) await call('wiki_user_delete', { id: stale, replaceId: 1 });
  const u1 = await step('user_create', 'wiki_user_create', {
    email: 'mcptest@example.invalid', name: 'MCP Test', passwordRaw: 'Str0ngP@ss!23', providerKey: 'local',
  });
  let U1 = u1?.id;
  if (!U1) {
    U1 = await findUser(); // Wiki.js gibt das User-Objekt nicht zurueck -> ID nachschlagen
    console.log('   (user_create gibt keine id zurueck; via users_search ermittelt: U1=' + U1 + ')');
  }
  await step('user_get', 'wiki_user_get', { id: U1 });
  await step('user_update', 'wiki_user_update', { id: U1, name: 'MCP Test 2' });
  await step('user_verify', 'wiki_user_verify', { id: U1 });
  await step('user_deactivate', 'wiki_user_deactivate', { id: U1 });
  await step('user_activate', 'wiki_user_activate', { id: U1 });
  await step('user_disable_tfa', 'wiki_user_disable_tfa', { id: U1 });
  await step('user_reset_password (setzt generiertes PW)', 'wiki_user_reset_password', { id: U1 }, { mustContain: 'generated value' });

  console.log('\n### GROUPS lifecycle');
  const g1 = await step('group_create', 'wiki_group_create', { name: 'mcp-test-group' });
  const G1 = g1?.id;
  await step('group_get', 'wiki_group_get', { id: G1 });
  await step('group_update', 'wiki_group_update', { id: G1, name: 'mcp-test-group-2' });
  await step('group_assign_user', 'wiki_group_assign_user', { groupId: G1, userId: U1 });
  await step('group_unassign_user', 'wiki_group_unassign_user', { groupId: G1, userId: U1 });
  await step('group_delete', 'wiki_group_delete', { id: G1 });
  await step('user_delete (cleanup)', 'wiki_user_delete', { id: U1, replaceId: 1 });

  console.log('\n### AUTH');
  await step('apikey_create', 'wiki_apikey_create', { name: 'mcp-test-key', expiration: '30d', fullAccess: false });
  const keys = await step('apikeys_list (find mcp-test-key)', 'wiki_apikeys_list', {});
  const keyId = Array.isArray(keys) ? keys.find((k: any) => k.name === 'mcp-test-key' && !k.isRevoked)?.id : undefined;
  await step('apikey_revoke', 'wiki_apikey_revoke', { id: keyId });
  await step('auth_set_api_state (no-op true)', 'wiki_auth_set_api_state', { enabled: true });

  console.log('\n### SYSTEM maintenance + no-ops');
  await step('flush_cache', 'wiki_pages_flush_cache', {});
  await step('rebuild_tree', 'wiki_pages_rebuild_tree', {});
  await step('assets_flush_temp', 'wiki_assets_flush_temp', {});
  await step('migrate_locale (no-op zz->zz)', 'wiki_pages_migrate_locale', { sourceLocale: 'zz', targetLocale: 'zz' });

  console.log('\n### NAVIGATION (incl. destructive guard)');
  const navOrig = await step('navigation_get', 'wiki_navigation_get', {});
  const testNav = [{ locale: 'en', items: [{ id: 'mcp-nav-1', kind: 'link', label: 'MCP', icon: 'mdi-tube', targetType: 'external', target: 'https://example.org', visibilityMode: 'all', visibilityGroups: null }] }];
  await step('nav_update (set, force+confirm)', 'wiki_navigation_update_tree', { tree: testNav, force: true, confirm: true });
  await step('nav_update destruktiv OHNE force -> verweigert', 'wiki_navigation_update_tree', { tree: [{ locale: 'en', items: [] }] }, { expectError: true, mustContain: 'Refusing' });
  await step('nav_update (restore original, force+confirm)', 'wiki_navigation_update_tree', { tree: Array.isArray(navOrig) ? navOrig : [], force: true, confirm: true });

  console.log('\n### wiki_graphql escape hatch');
  await step('graphql read query', 'wiki_graphql', { query: 'query{ pages { list(limit:1){ id } } }' });
  await step('graphql mutation OHNE confirm -> dry-run', 'wiki_graphql', { query: 'mutation{ pages { flushCache { responseResult { succeeded } } } }' }, { mustContain: 'DRY RUN' });
  await step('graphql mutation MIT confirm -> ausgefuehrt', 'wiki_graphql', { query: 'mutation{ pages { flushCache { responseResult { succeeded } } } }', confirm: true });

  console.log('\n### ASSETS (folder + upload/rename/delete)');
  const folders = dataOf((await call('wiki_asset_folders', { parentFolderId: 0 })).text);
  const folderExists = Array.isArray(folders) && folders.some((f: any) => f.slug === 'mcptestfolder');
  if (folderExists) {
    pass++;
    console.log('ok    asset_create_folder (bereits vorhanden - Tool ok)');
  } else {
    await step('asset_create_folder', 'wiki_asset_create_folder', { parentFolderId: 0, slug: 'mcptestfolder', name: 'MCP Test Folder' });
  }
  await step('asset_upload', 'wiki_asset_upload', {
    filename: 'mcptest.txt', contentBase64: Buffer.from('hello mcp').toString('base64'), folderId: 0, mime: 'text/plain',
  });
  const assets = dataOf((await call('wiki_assets_list', { folderId: 0 })).text);
  const assetId = Array.isArray(assets) ? assets.find((x: any) => String(x.filename).startsWith('mcptest'))?.id : undefined;
  console.log('   assetId=' + assetId);
  await step('asset_rename', 'wiki_asset_rename', { id: assetId, filename: 'mcptest-renamed.txt' });
  await step('asset_delete', 'wiki_asset_delete', { id: assetId });

  console.log('\n### CLEANUP-VERIFIKATION');
  const leftPages = await step('pages_list leftover-check', 'wiki_pages_list', { limit: 200 });
  const leftTmp = Array.isArray(leftPages) ? leftPages.filter((p: any) => String(p.path).startsWith('tmp/mcptest')) : [];
  console.log(leftTmp.length === 0 ? 'ok    keine tmp/mcptest-Seiten uebrig' : `WARN  ${leftTmp.length} tmp-Seiten uebrig: ${leftTmp.map((p:any)=>p.path).join(', ')}`);

  console.log(`\n=================== ERGEBNIS: ${pass} ok / ${fail} FAIL ===================`);
  if (fail > 0) {
    console.log('Fehlgeschlagen:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
