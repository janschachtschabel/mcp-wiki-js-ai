/**
 * Content-Security-Policy for the server-rendered pages (/, /me, /oauth/authorize).
 * - 'unsafe-inline' for scripts and styles: the App Router emits inline bootstrap
 *   scripts and the pages use inline styles. Nonces would need a request-time
 *   proxy/middleware; until then the policy still blocks every EXTERNAL source
 *   (script, style, image, fetch/XHR exfiltration), plugins and <base> hijacking.
 * - no form-action: the consent form answers with a 303 to the OAuth client's
 *   redirect_uri (another origin), and browsers apply form-action to that redirect.
 * - 'unsafe-eval' only outside production: React's development build needs eval()
 *   (callstack reconstruction) and logs a CSP error on every page without it.
 *   `next build` / the standalone server run with NODE_ENV=production and keep
 *   the strict policy.
 */
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV !== 'production' ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The MCP SDK ships ESM with subpath exports; let Next transpile it cleanly.
  transpilePackages: ['@modelcontextprotocol/server', 'mcp-handler'],
  // Self-contained server bundle for the Docker image (node .next/standalone/server.js).
  output: 'standalone',
  // Don't advertise the framework/version (audit R-28).
  poweredByHeader: false,
  // The authorize and /me pages must not be framed (clickjacking of the consent button).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Not `no-referrer`: browsers then send `Origin: null` on our own form posts,
          // which the CSRF check must reject. `same-origin` still sends nothing cross-site.
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
