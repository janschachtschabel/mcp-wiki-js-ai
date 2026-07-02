/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The MCP SDK ships ESM with subpath exports; let Next transpile it cleanly.
  transpilePackages: ['@modelcontextprotocol/sdk', 'mcp-handler'],
  // Self-contained server bundle for the Docker image (node .next/standalone/server.js).
  output: 'standalone',
};

export default nextConfig;
