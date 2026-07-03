import { headers } from 'next/headers';
import { allTools } from '../lib/tools/index';
import { SERVER_INFO } from '../lib/meta';
import { oauthEnabled } from '../lib/oauth/store';
import { card, code, h2, mono, muted, ol } from './theme';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'your-deploy.example.com';
  const base = `${proto}://${host}`;
  const mcpUrl = `${base}/mcp`;

  const byCategory = allTools.reduce<Record<string, number>>((acc, t) => {
    acc[t.category] = (acc[t.category] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '48px 24px 80px' }}>
      <h1 style={{ fontSize: 30, marginBottom: 4 }}>
        {SERVER_INFO.name} <span style={{ color: '#7d8bb5', fontSize: 18 }}>v{SERVER_INFO.version}</span>
      </h1>
      <p style={{ ...muted, marginTop: 0 }}>
        Wiki.js-MCP-Server — volle GraphQL-API, eigener API-Key pro Nutzer, feingranulare Rechte. Endpoint:{' '}
        <span style={mono}>{mcpUrl}</span>
      </p>

      {oauthEnabled() ? (
        <div style={{ ...card, border: '1px solid #2f4a2f', background: '#12241a' }}>
          <h2 style={h2}>✅ Empfohlen: Eine URL für alle — Login ist der Wiki-Login (OAuth)</h2>
          <p style={{ ...muted, marginTop: 2 }}>
            Diese URL enthält <strong>kein Geheimnis</strong> und ist für alle Team-Mitglieder gleich. Beim ersten
            Verbinden öffnet der Client den Wiki-Login (ein Klick, wenn du im Wiki schon angemeldet bist) — danach
            arbeitet der Agent mit <strong>deinen</strong> Wiki-Rechten:
          </p>
          <code style={code}>{mcpUrl}</code>
          <ol style={ol}>
            <li><strong>claude.ai / Claude Desktop:</strong> Settings → Connectors → Add custom connector → URL einfügen.</li>
            <li><strong>Claude Code:</strong> <span style={mono}>claude mcp add --transport http wiki {mcpUrl}</span>, dann <span style={mono}>/mcp</span> → Authenticate.</li>
            <li><strong>ChatGPT / Codex:</strong> Connector mit dieser URL anlegen — der OAuth-Login startet automatisch.</li>
          </ol>
          <p style={{ ...muted, fontSize: 13, marginBottom: 0 }}>
            Eigene Verbindungen ansehen &amp; widerrufen: <a href="/me" style={{ color: '#7ab3ff' }}>/me</a>. Die
            Varianten unten (Handle/BYOK) bleiben als Fallback erhalten.
          </p>
        </div>
      ) : null}

      {/* ChatGPT & claude.ai web — URL parameter, profile handle */}
      <div style={card}>
        <h2 style={h2}>🔗 ChatGPT (Developer Mode) &amp; claude.ai (Web-Connector)</h2>
        <p style={{ ...muted, marginTop: 2 }}>
          Diese Clients erlauben <strong>keine</strong> Custom-Header — dein Zugang kommt in die <strong>URL</strong>.
          Empfohlen: dein <strong>geheimer Profil-Handle</strong> (der echte Wiki.js-Key bleibt serverseitig):
        </p>
        <code style={code}>{`${mcpUrl}?token=wzp_DEIN_GEHEIMER_HANDLE`}</code>
        <ol style={ol}>
          <li>
            <strong>ChatGPT:</strong> Settings → Connectors → (Advanced → Developer mode) → <em>Create / Add custom
            connector</em> → obige URL einfügen → Authentication: <em>No authentication</em> → speichern.
          </li>
          <li>
            <strong>claude.ai:</strong> Settings → Connectors → <em>Add custom connector</em> → obige URL einfügen →{' '}
            <em>Add</em>. (Plan Pro/Max/Team/Enterprise.)
          </li>
        </ol>
        <p style={{ ...muted, fontSize: 13, marginBottom: 0 }}>
          Der Betreiber legt Handles + Rollen in <span style={mono}>WIKIJS_PROFILES</span> an (
          <span style={mono}>npm run gen:profile -- &quot;Name:rolle&quot;</span>); die Wiki-URL einmal global via{' '}
          <span style={mono}>WIKIJS_URL</span>. Ohne Profile direktes BYOK:{' '}
          <span style={mono}>?url=https://dein-wiki…&amp;token=DEIN_KEY</span>.
        </p>
      </div>

      {/* Claude Code / Cursor — headers, profile handle */}
      <div style={card}>
        <h2 style={h2}>💻 Claude Code (CLI) &amp; Cursor</h2>
        <p style={{ ...muted, marginTop: 2 }}>
          Diese Clients unterstützen Header — der Handle/Key bleibt aus der URL heraus:
        </p>
        <code style={code}>{`claude mcp add --transport http wikijs ${mcpUrl} \\
  --header "X-Wikijs-Token: wzp_DEIN_GEHEIMER_HANDLE"`}</code>
        <p style={{ ...muted, fontSize: 13, marginBottom: 0 }}>
          Ohne Profile (direktes BYOK): zusätzlich{' '}
          <span style={mono}>--header &quot;X-Wikijs-Url: https://dein-wiki…&quot;</span> und den echten Key als Token.
          Cursor: <span style={mono}>.cursor/mcp.json</span> mit <span style={mono}>headers</span> (siehe{' '}
          <span style={mono}>docs/clients-claude.md</span>).
        </p>
      </div>

      {/* Single-tenant note */}
      <div style={card}>
        <h2 style={h2}>🏢 Eine feste Instanz für alle (ohne Key pro Nutzer)</h2>
        <p style={{ ...muted, margin: '2px 0 0' }}>
          Ist der Server mit <span style={mono}>WIKIJS_URL</span> + <span style={mono}>WIKIJS_TOKEN</span> deployt,
          genügt als Connector-URL einfach <span style={mono}>{mcpUrl}</span> — ganz ohne Auth.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ ...card, flex: '1 1 240px' }}>
          <strong>{allTools.length} Tools</strong>
          <ul style={{ ...muted, lineHeight: 1.6, margin: '6px 0 0', paddingLeft: 18 }}>
            {Object.entries(byCategory).map(([cat, n]) => (
              <li key={cat}>
                <span style={mono}>{cat}</span>: {n}
              </li>
            ))}
          </ul>
        </div>
        <div style={{ ...card, flex: '1 1 240px' }}>
          <strong>Rechte (Rollen)</strong>
          <p style={{ ...muted, margin: '6px 0 0', fontSize: 13 }}>
            Pro Person eine <strong>Rolle</strong> (<span style={mono}>leser → systemadmin</span>), definiert in{' '}
            <span style={mono}>config/roles.json</span>. Modi je Kategorie/Tool: <em>allow</em> / <em>confirm</em>{' '}
            (Dry-Run bis <span style={mono}>confirm:true</span>) / <em>block</em>. Obergrenze via{' '}
            <span style={mono}>WIKIJS_PERMISSION_PRESET</span>. Matrix: <span style={mono}>docs/roles.md</span> ·{' '}
            <span style={mono}>npm run roles</span>.
          </p>
        </div>
      </div>

      <p style={{ color: '#5f6f9c', fontSize: 13 }}>
        Verbindung prüfen: das Tool <span style={mono}>wiki_connection_status</span> aufrufen lassen. Vollständige
        Doku im Repository unter <span style={mono}>docs/</span>.
      </p>
    </main>
  );
}
