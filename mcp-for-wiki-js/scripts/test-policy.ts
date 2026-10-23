/**
 * Pure-logic tests for the permission engine (no network, no server).
 * Run: npm run test:policy
 */
import assert from 'node:assert';
import { basePolicyFromEnv, parsePolicyConfig, roleConfig, DEFAULT_PRESET } from '../lib/permissions';

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed++;
  console.log('ok  -', label);
}

// 1. "safe" preset baseline
const safe = basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'safe'});
check('safe: read = allow', () => assert.equal(safe.resolve('wiki_pages_search', 'read'), 'allow'));
check('safe: write = confirm', () => assert.equal(safe.resolve('wiki_page_create', 'write'), 'confirm'));
check('safe: delete = confirm', () => assert.equal(safe.resolve('wiki_page_delete', 'delete'), 'confirm'));
check('safe: manage_users = block', () => assert.equal(safe.resolve('wiki_user_create', 'manage_users'), 'block'));
check('safe: manage_system = block', () => assert.equal(safe.resolve('wiki_graphql', 'manage_system'), 'block'));

// 2. env JSON override: per-category and per-tool (tool override wins)
const custom = basePolicyFromEnv({
  WIKIJS_PERMISSION_PRESET: 'safe',
  WIKIJS_POLICY: JSON.stringify({ categories: { delete: 'allow' }, tools: { wiki_page_create: 'block' } }),
});
check('override: delete category -> allow', () => assert.equal(custom.resolve('wiki_page_delete', 'delete'), 'allow'));
check('override: per-tool wins over category', () =>
  assert.equal(custom.resolve('wiki_page_create', 'write'), 'block'));

// 3. request overlay can only TIGHTEN, never loosen
check('overlay tightens read allow -> confirm', () =>
  assert.equal(safe.withOverlay({ categories: { read: 'confirm' } }).resolve('wiki_pages_search', 'read'), 'confirm'));
check('overlay cannot loosen delete confirm -> allow', () =>
  assert.equal(safe.withOverlay({ categories: { delete: 'allow' } }).resolve('wiki_page_delete', 'delete'), 'confirm'));

// 4. overlay preset "readonly" tightens everything except read
const ro = safe.withOverlay({ preset: 'readonly' });
check('overlay readonly: write -> block', () => assert.equal(ro.resolve('wiki_page_create', 'write'), 'block'));
check('overlay readonly: read stays allow', () => assert.equal(ro.resolve('wiki_pages_search', 'read'), 'allow'));

// 5. parsePolicyConfig sanitizes junk
check('parse: invalid JSON -> undefined', () => assert.equal(parsePolicyConfig('not json'), undefined));
check('parse: drops bogus category + invalid mode', () => {
  const cfg = parsePolicyConfig(JSON.stringify({ categories: { bogus: 'allow', delete: 'weird', write: 'block' } }));
  assert.deepEqual(cfg?.categories, { write: 'block' });
});

// 6. ROLES assigned per person (applied as a tighten-only overlay on the ceiling)
const editor = basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'editor' });
check('role leser on editor ceiling: write -> block', () =>
  assert.equal(editor.withOverlay(roleConfig('leser')).resolve('wiki_page_create', 'write'), 'block'));
check('role leser: read stays allow', () =>
  assert.equal(editor.withOverlay(roleConfig('leser')).resolve('wiki_pages_search', 'read'), 'allow'));

const kommentator = editor.withOverlay(roleConfig('kommentator'));
check('role kommentator: comment_create ALLOWED (per-tool)', () =>
  assert.equal(kommentator.resolve('wiki_comment_create', 'write'), 'allow'));
check('role kommentator: page_create BLOCKED (write category)', () =>
  assert.equal(kommentator.resolve('wiki_page_create', 'write'), 'block'));

const redakteur = editor.withOverlay(roleConfig('redakteur'));
check('role redakteur: write allowed', () => assert.equal(redakteur.resolve('wiki_page_create', 'write'), 'allow'));
check('role redakteur: delete confirm', () => assert.equal(redakteur.resolve('wiki_page_delete', 'delete'), 'confirm'));

// 7. the global ceiling caps a high role
const cappedAdmin = safe.withOverlay(roleConfig('systemadmin'));
check('ceiling "safe" caps systemadmin: write -> confirm (not allow)', () =>
  assert.equal(cappedAdmin.resolve('wiki_page_create', 'write'), 'confirm'));
check('ceiling "safe" caps systemadmin: manage_users -> block', () =>
  assert.equal(cappedAdmin.resolve('wiki_user_create', 'manage_users'), 'block'));

// 8. audit R-03: an unknown role must fail CLOSED (error), a missing role gets defaultRole
check('unknown role name -> throws (no silent fall-back to the ceiling)', () =>
  assert.throws(() => roleConfig('does-not-exist'), /Unknown role "does-not-exist"/));
check('missing role -> defaultRole overlay (not the ceiling)', () =>
  assert.deepEqual(roleConfig(undefined), roleConfig(DEFAULT_PRESET)));
check('missing role on systemadmin ceiling: defaultRole "safe" -> write confirm', () =>
  assert.equal(
    basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'systemadmin' }).withOverlay(roleConfig(undefined)).resolve('wiki_page_create', 'write'),
    'confirm',
  ));

// 9. audit A-11: a role used as PRESET keeps its per-tool rules (roles.json: wiki_graphql block)
check('A-11: preset "betreuer" keeps wiki_graphql blocked (role tool rule, inherited via extends)', () =>
  assert.equal(basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'betreuer' }).resolve('wiki_graphql', 'manage_system'), 'block'));
check('A-11: preset "wiki" keeps wiki_graphql blocked', () =>
  assert.equal(basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'wiki' }).resolve('wiki_graphql', 'manage_system'), 'block'));
check('A-11: WIKIJS_POLICY tools still override the preset deliberately', () =>
  assert.equal(
    basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'betreuer', WIKIJS_POLICY: JSON.stringify({ tools: { wiki_graphql: 'confirm' } }) }).resolve('wiki_graphql', 'manage_system'),
    'confirm',
  ));
check('A-11: a preset overlay (X-Wikijs-Preset) carries the role tool rules too', () =>
  assert.equal(basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'full' }).withOverlay({ preset: 'betreuer' }).resolve('wiki_graphql', 'manage_system'), 'block'));
check('A-11: other manage_system tools keep the preset category mode', () =>
  assert.equal(basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'betreuer' }).resolve('wiki_site_config', 'manage_system'), 'confirm'));

// 10. review of A-11 (S6): inside ONE overlay a preset's tool rule and an explicit
// category both tighten — neither shadows the other.
const sysCeiling = basePolicyFromEnv({ WIKIJS_PERMISSION_PRESET: 'systemadmin' });
check('S6: overlay {preset kommentator, categories.write block} blocks comment_create', () =>
  assert.equal(sysCeiling.withOverlay({ preset: 'kommentator', categories: { write: 'block' } }).resolve('wiki_comment_create', 'write'), 'block'));
check('S6: overlay preset kommentator alone still allows comment_create', () =>
  assert.equal(sysCeiling.withOverlay({ preset: 'kommentator' }).resolve('wiki_comment_create', 'write'), 'allow'));
check('S6: overlay preset kommentator alone blocks page_create', () =>
  assert.equal(sysCeiling.withOverlay({ preset: 'kommentator' }).resolve('wiki_page_create', 'write'), 'block'));

console.log(`\n${passed} policy assertions passed.`);
