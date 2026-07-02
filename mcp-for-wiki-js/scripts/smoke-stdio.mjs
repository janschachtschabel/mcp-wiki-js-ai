// Smoke test for the stdio transport: spawns bin/stdio.ts and lists tools.
// Run from the project root: node scripts/smoke-stdio.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['node_modules/tsx/dist/cli.mjs', 'bin/stdio.ts'],
  env: {
    ...process.env,
    WIKIJS_URL: 'https://wiki.invalid.example',
    WIKIJS_TOKEN: 'dummy-token',
    WIKIJS_PERMISSION_PRESET: 'editor', // read+write allow, delete confirm, manage_* block
  },
});

const client = new Client({ name: 'smoke-stdio', version: '1.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  console.log(`stdio connected; tools/list returned ${tools.length} tools (preset "editor")`);
  const checks = [
    ['read visible', names.has('wiki_pages_search')],
    ['write visible', names.has('wiki_page_create')],
    ['delete visible', names.has('wiki_page_delete')],
    ['manage_users hidden', !names.has('wiki_user_create')],
  ];
  let bad = 0;
  for (const [label, pass] of checks) {
    console.log((pass ? 'ok  - ' : 'FAIL- ') + label);
    if (!pass) bad++;
  }
  process.exitCode = bad ? 1 : 0;
  console.log(bad ? 'STDIO SMOKE FAILED' : 'STDIO SMOKE DONE');
} catch (err) {
  console.error('STDIO SMOKE ERROR:', err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
