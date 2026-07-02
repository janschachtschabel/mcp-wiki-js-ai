// End-to-end smoke test against a running server.
// Usage: node scripts/smoke.mjs [http://localhost:3031/mcp]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = process.argv[2] || 'http://localhost:3031/mcp';

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: {
    headers: {
      'X-Wikijs-Url': 'https://wiki.invalid.example',
      'X-Wikijs-Token': 'dummy-token-for-smoke-test',
    },
  },
});

const client = new Client({ name: 'smoke', version: '1.0.0' });

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERT FAILED:', msg);
    process.exitCode = 1;
  } else {
    console.log('ok  -', msg);
  }
}

try {
  await client.connect(transport);
  console.log('connected via Streamable HTTP\n');

  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  console.log(`tools/list returned ${tools.length} tools (preset "safe")`);

  // read + write + delete should be visible
  assert(names.has('wiki_pages_search'), 'read tool visible (wiki_pages_search)');
  assert(names.has('wiki_page_create'), 'write tool visible (wiki_page_create)');
  assert(names.has('wiki_page_delete'), 'delete tool visible (wiki_page_delete)');
  // manage_* must be hidden under the safe preset
  assert(!names.has('wiki_user_create'), 'manage_users tool hidden (wiki_user_create)');
  assert(!names.has('wiki_graphql'), 'manage_system escape hatch hidden (wiki_graphql)');
  assert(!names.has('wiki_apikey_create'), 'manage_auth tool hidden (wiki_apikey_create)');

  // confirm param should be present on a write tool, absent on a read tool
  const createTool = tools.find((t) => t.name === 'wiki_page_create');
  assert(
    createTool?.inputSchema?.properties && 'confirm' in createTool.inputSchema.properties,
    'write tool exposes confirm param',
  );

  // read tool (allow) executes — dummy host means it reports not connected, gracefully
  const status = await client.callTool({ name: 'wiki_connection_status', arguments: {} });
  const statusText = status.content?.[0]?.text ?? '';
  console.log('\nwiki_connection_status ->', statusText.replace(/\s+/g, ' ').slice(0, 160));
  assert(statusText.includes('"connected": false'), 'read tool executed and returned graceful status');

  // write tool (confirm) without confirm -> dry-run preview, NOT executed
  const preview = await client.callTool({
    name: 'wiki_page_create',
    arguments: { path: 'smoke/test', title: 'Smoke', content: '# hi' },
  });
  const previewText = preview.content?.[0]?.text ?? '';
  console.log('\nwiki_page_create (no confirm) ->', previewText.replace(/\s+/g, ' ').slice(0, 120));
  assert(previewText.includes('Confirmation required'), 'confirm gate returns dry-run preview');
  assert(preview.isError !== true, 'confirm preview is not an error');

  console.log('\nSMOKE TEST DONE');
} catch (err) {
  console.error('SMOKE TEST ERROR:', err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
