import { cookies, headers } from 'next/headers';
import { oauthEnabled } from '../../lib/oauth/store';
import { identityFromCookies, isWikiAdmin } from '../../lib/oauth/web';
import { card, code, dangerBtn, input, label, muted, primaryBtn, td, th } from '../theme';

export const dynamic = 'force-dynamic';

/**
 * Self-service page: shows the signed-in wiki user THEIR OWN AI connections
 * (OAuth sessions) with one-click revoke, plus the copy-paste connection info.
 * Identity comes from the wiki `jwt` cookie (same-domain SSO) or a one-off
 * login against Wiki.js — no separate account, nothing to configure per user.
 */

async function baseUrlFromHeaders(): Promise<string> {
  if (process.env.PUBLIC_BASE_URL) return new URL(process.env.PUBLIC_BASE_URL).origin;
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3030';
  return `${proto}://${host}`;
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

export default async function MePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const base = await baseUrlFromHeaders();
  const mcpUrl = `${base}/mcp`;
  const sp = await searchParams;

  if (!oauthEnabled()) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px 80px' }}>
        <h1 style={{ fontSize: 24 }}>Meine KI-Zugänge</h1>
        <div style={card}>
          <p style={muted}>OAuth ist auf diesem Deployment nicht aktiviert (MCP_SESSION_SECRET fehlt).</p>
        </div>
      </main>
    );
  }

  const me = await identityFromCookies(await cookies());
  const rawError = sp.login_error;
  const loginError = (Array.isArray(rawError) ? rawError[0] : rawError)?.slice(0, 200);

  if (!me) {
    return (
      <main style={{ maxWidth: 520, margin: '0 auto', padding: '48px 24px 80px' }}>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Meine KI-Zugänge</h1>
        <p style={muted}>Melde dich mit deinem normalen Wiki-Login an, um deine Verbindungen zu sehen.</p>
        {loginError ? (
          <div style={{ ...card, border: '1px solid #7f1d1d', background: '#2a1420' }}>
            <p style={{ color: '#fca5a5', margin: 0 }}>{loginError}</p>
          </div>
        ) : null}
        <div style={card}>
          <form method="post" action="/me/login">
            <label style={label} htmlFor="username">E-Mail / Benutzername</label>
            <input style={input} id="username" name="username" autoComplete="username" required />
            <label style={label} htmlFor="password">Passwort</label>
            <input style={input} id="password" name="password" type="password" autoComplete="current-password" required />
            <button type="submit" style={primaryBtn}>Anmelden</button>
          </form>
          <p style={{ ...muted, fontSize: 13, marginBottom: 0 }}>
            Tipp: Bist du im Wiki bereits angemeldet (gleiche Domain), entfällt dieser Schritt automatisch.
          </p>
        </div>
      </main>
    );
  }

  const { listSessionsByEmail, listActiveSessions, listAudit } = await import('../../lib/oauth/store');
  const sessions = listSessionsByEmail(me.identity.email);
  const active = sessions.filter((s) => !s.revokedAt);
  const revoked = sessions.filter((s) => s.revokedAt);
  // Admin section: gated by Wiki.js' own permission model (users.list probe).
  const admin = await isWikiAdmin(me.jwt);
  const allActive = admin ? listActiveSessions() : [];
  const audit = admin ? listAudit(30) : [];

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 80px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Meine KI-Zugänge</h1>
      <p style={muted}>
        Angemeldet als <strong style={{ color: '#e7ecff' }}>{me.identity.name}</strong> ({me.identity.email})
        {me.source === 'wiki-cookie' ? ' — über deine Wiki-Sitzung.' : '.'}
        {me.source === 'me-cookie' ? (
          <form method="post" action="/me/logout" style={{ display: 'inline', marginLeft: 8 }}>
            <button type="submit" style={{ ...dangerBtn, border: '1px solid #25304f', color: '#9fb0db' }}>Abmelden</button>
          </form>
        ) : null}
      </p>

      <div style={card}>
        <h2 style={{ fontSize: 17, margin: '2px 0 6px' }}>🔌 Verbinden — eine URL für alles</h2>
        <p style={{ ...muted, marginTop: 0, fontSize: 14 }}>
          Diese URL enthält kein Geheimnis und ist für alle gleich. Beim ersten Verbinden öffnet dein Client den
          Wiki-Login (ein Klick, wenn du schon angemeldet bist):
        </p>
        <code style={code}>{mcpUrl}</code>
        <ul style={{ ...muted, fontSize: 14, lineHeight: 1.8, margin: '6px 0', paddingLeft: 20 }}>
          <li><strong>claude.ai / Claude Desktop:</strong> Settings → Connectors → Add custom connector → URL einfügen</li>
          <li><strong>Claude Code:</strong> <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>claude mcp add --transport http wiki {mcpUrl}</span>, dann <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>/mcp</span> → Authenticate</li>
          <li><strong>ChatGPT / Codex:</strong> Connector mit dieser URL anlegen → OAuth-Login folgt automatisch</li>
        </ul>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: 17, margin: '2px 0 6px' }}>Aktive Verbindungen ({active.length})</h2>
        {active.length === 0 ? (
          <p style={{ ...muted, marginBottom: 0 }}>Noch keine — verbinde einen Client mit der URL oben.</p>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={th}>Client</th>
                <th style={th}>Verbunden seit</th>
                <th style={th}>Zuletzt genutzt</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {active.map((s) => (
                <tr key={s.id}>
                  <td style={td}>{s.clientName}</td>
                  <td style={td}>{fmt(s.createdAt)}</td>
                  <td style={td}>{fmt(s.lastUsedAt)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <form method="post" action="/me/revoke" style={{ display: 'inline' }}>
                      <input type="hidden" name="session_id" value={s.id} />
                      <button type="submit" style={dangerBtn}>Widerrufen</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {revoked.length > 0 ? (
          <p style={{ ...muted, fontSize: 13, marginBottom: 0 }}>{revoked.length} widerrufene Verbindung(en) werden nicht mehr angezeigt, sobald sie ablaufen.</p>
        ) : null}
      </div>

      <p style={{ ...muted, fontSize: 13 }}>
        Ein Widerruf wirkt sofort: Der Client verliert den Zugriff und muss neu autorisiert werden. Deine Rechte im
        Wiki selbst bleiben unverändert.
      </p>

      {admin ? (
        <>
          <div style={{ ...card, border: '1px solid #4a3a1f' }}>
            <h2 style={{ fontSize: 17, margin: '2px 0 6px' }}>🛡️ Alle aktiven KI-Verbindungen (Admin, {allActive.length})</h2>
            {allActive.length === 0 ? (
              <p style={{ ...muted, marginBottom: 0 }}>Team-weit keine aktiven Verbindungen.</p>
            ) : (
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={th}>Person</th>
                    <th style={th}>Client</th>
                    <th style={th}>Zuletzt genutzt</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {allActive.map((s) => (
                    <tr key={s.id}>
                      <td style={td}>{s.userLabel} <span style={{ ...muted, fontSize: 12 }}>({s.userEmail})</span></td>
                      <td style={td}>{s.clientName}</td>
                      <td style={td}>{fmt(s.lastUsedAt)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <form method="post" action="/me/revoke" style={{ display: 'inline' }}>
                          <input type="hidden" name="session_id" value={s.id} />
                          <button type="submit" style={dangerBtn}>Widerrufen</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ ...card, border: '1px solid #4a3a1f' }}>
            <h2 style={{ fontSize: 17, margin: '2px 0 6px' }}>📋 Audit-Log (Admin, letzte {audit.length})</h2>
            <p style={{ ...muted, marginTop: 0, fontSize: 13 }}>
              Schreib-, Lösch- und Admin-Aktionen der KI-Agenten. Lese-Zugriffe werden nicht protokolliert.
            </p>
            {audit.length === 0 ? (
              <p style={{ ...muted, marginBottom: 0 }}>Noch keine Einträge.</p>
            ) : (
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={th}>Zeit</th>
                    <th style={th}>Person</th>
                    <th style={th}>Aktion</th>
                    <th style={th}>Ergebnis</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a, i) => (
                    <tr key={i}>
                      <td style={td}>{fmt(a.ts)}</td>
                      <td style={td}>{a.profile ?? '—'}</td>
                      <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 13 }}>{a.tool}</td>
                      <td style={td}>{a.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </main>
  );
}
