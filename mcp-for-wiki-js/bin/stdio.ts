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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAll } from '../lib/register';
import { SERVER_INFO, INSTRUCTIONS } from '../lib/meta';

async function main(): Promise<void> {
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
  // Ignore EPIPE (client closed stdout); log anything else.
  process.on('uncaughtException', (err: Error & { code?: string }) => {
    if (err.code === 'EPIPE') return;
    console.error('[mcp-wikijs-mv] uncaught:', err);
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
