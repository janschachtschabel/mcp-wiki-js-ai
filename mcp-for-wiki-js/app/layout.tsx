import type { ReactNode } from 'react';

export const metadata = {
  title: 'mcp-wikijs-mv',
  description: 'Wiki.js MCP server — Streamable HTTP (Vercel) + stdio, per-user keys, permission policy.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
          background: '#0b1020',
          color: '#e7ecff',
        }}
      >
        {children}
      </body>
    </html>
  );
}
