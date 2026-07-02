// Smoke test for URL-parameter auth (for clients that can't set custom headers,
// e.g. claude.ai web custom connectors / ChatGPT developer mode).
// Connects with NO credential headers — only ?url=&token= on the endpoint URL.
// Run: node scripts/smoke-urlauth.mjs [http://localhost:3031/mcp]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] || 'http://localhost:3031/mcp';
const WIKI = 'https://wiki.url-param.example';
const endpoint = `${base}?url=${encodeURIComponent(WIKI)}&token=dummy-url-token&preset=readonly`;

const transport = new StreamableHTTPClientTransport(new URL(endpoint)); // no headers at all
const client = new Client({ name: 'smoke-urlauth', version: '1.0.0' });

let bad = 0;
const ok = (label, pass) => {
  console.log((pass ? 'ok  - ' : 'FAIL- ') + label);
  if (!pass) bad++;
};

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`connected via ?url=&token= ; ${tools.length} tools visible`);
  const names = new Set(tools.map((t) => t.name));
  ok('read tool present', names.has('wiki_pages_search'));

  const res = await client.callTool({ name: 'wiki_connection_status', arguments: {} });
  const text = res.content?.[0]?.text ?? '';
  console.log('connection_status ->', text.replace(/\s+/g, ' ').slice(0, 140));
  ok('baseUrl came from ?url= query param', text.includes(WIKI));
  ok('token came from ?token= query param', text.includes('"hasToken": true'));

  // ?preset=readonly is applied as a call-time overlay (tighten-only): a write call is blocked.
  const blocked = await client.callTool({ name: 'wiki_page_create', arguments: { path: 'x', title: 'x', content: 'x', confirm: true } });
  const blockedText = blocked.content?.[0]?.text ?? '';
  console.log('wiki_page_create (preset=readonly) ->', blockedText.replace(/\s+/g, ' ').slice(0, 110));
  ok('?preset=readonly overlay blocks write at call time', blocked.isError === true && /blocked by the active permission policy/.test(blockedText));

  console.log(bad ? 'URL-AUTH SMOKE FAILED' : 'URL-AUTH SMOKE DONE');
  process.exitCode = bad ? 1 : 0;
} catch (err) {
  console.error('URL-AUTH SMOKE ERROR:', err);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
