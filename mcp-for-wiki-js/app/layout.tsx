import type { ReactNode } from 'react';
import { color } from './theme';

export const metadata = {
  // Each page sets its own title (R-52); this is the fallback and the suffix.
  title: { default: 'Wiki-MCP-Server', template: '%s – Wiki-MCP-Server' },
  description: 'Wiki.js MCP server — Streamable HTTP (Vercel) + stdio, per-user keys, permission policy.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body
        style={{
          margin: 0,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
          background: color.page,
          color: color.text,
        }}
      >
        {children}
      </body>
    </html>
  );
}
