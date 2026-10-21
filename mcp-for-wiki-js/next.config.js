/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The MCP SDK ships ESM with subpath exports; let Next transpile it cleanly.
  transpilePackages: ['@modelcontextprotocol/server', 'mcp-handler'],
  // Self-contained server bundle for the Docker image (node .next/standalone/server.js).
  output: 'standalone',
  // The authorize and /me pages must not be framed (clickjacking of the consent button).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
