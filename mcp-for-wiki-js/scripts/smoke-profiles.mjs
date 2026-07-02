// Smoke test for WIKIJS_PROFILES with assigned ROLES and a single global WIKIJS_URL.
// Start the server with:
//   WIKIJS_URL=https://wiki.test.example
//   WIKIJS_PERMISSION_PRESET=editor   (ceiling so 'redakteur' can write)
//   WIKIJS_PROFILES={"wzp_test_alice":{"label":"Alice","token":"dummy","role":"leser"},
//                    "wzp_test_bob":{"label":"Bob","token":"dummy","role":"redakteur"},
//                    "wzp_test_carl":{"label":"Carl","token":"dummy","role":"kommentator"}}
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] || 'http://localhost:3031/mcp';
let bad = 0;
const ok = (l, p) => {
  console.log((p ? 'ok  - ' : 'FAIL- ') + l);
  if (!p) bad++;
};

async function connect(secret) {
  const t = new StreamableHTTPClientTransport(new URL(`${base}?token=${secret}`));
  const c = new Client({ name: 'smoke-profiles', version: '1.0.0' });
  await c.connect(t);
  return c;
}
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
const text = (r) => r.content?.[0]?.text ?? '';
const blocked = (r) => r.isError === true && /blocked by the active permission policy/.test(text(r));

try {
  // --- Alice = leser (read-only) ---
  const alice = await connect('wzp_test_alice');
  const aStatus = JSON.parse(text(await call(alice, 'wiki_connection_status')));
  console.log('Alice ->', JSON.stringify(aStatus).slice(0, 130));
  ok('Alice label shown (not secret)', aStatus.profile === 'Alice');
  ok('Alice uses the GLOBAL wiki url', String(aStatus.baseUrl).includes('wiki.test.example'));
  ok('leser: page write BLOCKED', blocked(await call(alice, 'wiki_page_create', { path: 'x', title: 'x', content: 'x', confirm: true })));
  await alice.close();

  // --- Bob = redakteur (read + write + delete-confirm) ---
  const bob = await connect('wzp_test_bob');
  ok('Bob label shown', JSON.parse(text(await call(bob, 'wiki_connection_status'))).profile === 'Bob');
  ok('redakteur: page write NOT blocked', !blocked(await call(bob, 'wiki_page_create', { path: 'x', title: 'x', content: 'x', confirm: true })));
  await bob.close();

  // --- Carl = kommentator (read + ONLY comment writes) ---
  const carl = await connect('wzp_test_carl');
  ok('Carl label shown', JSON.parse(text(await call(carl, 'wiki_connection_status'))).profile === 'Carl');
  ok('kommentator: comment_create NOT blocked (per-tool)', !blocked(await call(carl, 'wiki_comment_create', { pageId: 1, content: 'hi', confirm: true })));
  ok('kommentator: page_create BLOCKED (write category)', blocked(await call(carl, 'wiki_page_create', { path: 'x', title: 'x', content: 'x', confirm: true })));
  await carl.close();

  console.log(bad ? 'PROFILES SMOKE FAILED' : 'PROFILES SMOKE DONE');
  process.exitCode = bad ? 1 : 0;
} catch (e) {
  console.error('PROFILES SMOKE ERROR:', e?.message || e);
  process.exitCode = 1;
}
