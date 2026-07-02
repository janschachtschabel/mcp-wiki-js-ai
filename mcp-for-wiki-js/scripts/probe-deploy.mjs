// Probe a deployment WITHOUT credential headers — reveals the deploy's base preset
// and whether server-side env (WIKIJS_URL/WIKIJS_TOKEN) is configured & reachable.
// Run: node scripts/probe-deploy.mjs https://<deploy>/mcp
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] || 'http://localhost:3031/mcp';
const transport = new StreamableHTTPClientTransport(new URL(base)); // no headers
const client = new Client({ name: 'probe-deploy', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`connected (no credentials); ${tools.length} tools visible → reflects the deploy's base preset`);
  const res = await client.callTool({ name: 'wiki_connection_status', arguments: {} });
  console.log('wiki_connection_status (uses server env) ->', (res.content?.[0]?.text ?? '').replace(/\s+/g, ' '));
} catch (e) {
  console.error('PROBE ERROR:', e?.message || e);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
