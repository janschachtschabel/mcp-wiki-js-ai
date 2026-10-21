#!/usr/bin/env node
/**
 * Local stdio transport for desktop MCP clients (Claude Desktop, Cursor, ...).
 *
 * Single-user: credentials come from env (WIKIJS_URL + WIKIJS_TOKEN) and the
 * permission policy from WIKIJS_PERMISSION_PRESET / WIKIJS_POLICY.
 *
 * Run with:  npm run stdio        (uses tsx)
 *        or: node --import tsx bin/stdio.ts
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAll } from '../lib/register';
import { SERVER_INFO, INSTRUCTIONS } from '../lib/meta';
import { assertConfig } from '../lib/config-check';
import { enableStdioMode } from '../lib/context';

async function main(): Promise<void> {
  // Same startup check as the HTTP server (instrumentation.ts); warnings → stderr.
  assertConfig(process.env, (msg) => console.error(`[mcp-wikijs-mv] ${msg}`), { stdio: true });
  enableStdioMode();
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerAll(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean shutdown so the client doesn't see a hard kill.
  const shutdown = async (signal: string) => {
    console.error(`[mcp-wikijs-mv] ${signal} — shutting down.`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Ignore EPIPE (client closed stdout). Anything else leaves the process in an
  // unknown state — log it and exit non-zero so the client sees the crash and can
  // restart the server instead of talking to a half-broken one (audit R-37).
  process.on('uncaughtException', (err: Error & { code?: string }) => {
    if (err.code === 'EPIPE') return;
    console.error('[mcp-wikijs-mv] uncaught:', err);
    process.exit(1);
  });

  // Log to stderr (stdout is reserved for the MCP protocol).
  if (!process.env.WIKIJS_URL) {
    console.error('[mcp-wikijs-mv] warning: WIKIJS_URL is not set — tool calls will fail until it is.');
  }
  console.error(`[mcp-wikijs-mv] stdio server ready (v${SERVER_INFO.version}).`);
}

main().catch((err) => {
  console.error('[mcp-wikijs-mv] fatal:', err);
  process.exit(1);
});
