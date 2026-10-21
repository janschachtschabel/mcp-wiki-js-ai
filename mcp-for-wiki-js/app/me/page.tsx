import { cookies, headers } from 'next/headers';
import { oauthEnabled } from '../../lib/oauth/store';
import { resolveIssuer } from '../../lib/oauth/metadata';
import { loginErrorText } from '../../lib/oauth/messages';
import { isSessionActive } from '../../lib/oauth/service';
import { CONSENT_NONCE_HEADER, identityFromCookies, isSecureHeaders, isWikiAdmin } from '../../lib/oauth/web';
import { adminCard, card, code, dangerBtn, emphasis, input, label, muted, primaryBtn, quietBtn, srOnly, td, th } from '../theme';
import { ErrorBox } from '../ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Meine KI-Zugänge' };

/**
 * Self-service page: shows the signed-in wiki user THEIR OWN AI connections
 * (OAuth sessions) with one-click revoke, plus the copy-paste connection info.
 * Identity comes from the wiki `jwt` cookie (same-domain SSO) or a one-off
 * login against Wiki.js — no separate account, nothing to configure per user.
 */

/** Server-side time with its zone named (container default: UTC; set TZ to change). R-52 */
const timeFormat = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

function Time({ ts }: { ts: number }) {
  return <time dateTime={new Date(ts).toISOString()}>{timeFormat.format(ts)}</time>;
}

/** CSRF nonce of this render (minted by proxy.ts); every /me form posts it back. */
function Csrf({ nonce }: { nonce: string }) {
  return <input type="hidden" name="csrf" value={nonce} />;
}

function RevokeButton({ sessionId, clientName, person, nonce }: { sessionId: string; clientName: string; person?: string; nonce: string }) {
  const target = person ? `„${clientName}“ von ${person}` : `„${clientName}“`;
  return (
    <form method="post" action="/me/revoke" style={{ display: 'inline' }}>
      <Csrf nonce={nonce} />
      <input type="hidden" name="session_id" value={sessionId} />
      <button type="submit" style={dangerBtn} aria-label={`Verbindung ${target} widerrufen`}>
        Widerrufen
      </button>
    </form>
  );
}

export default async function MePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const h = await headers();
  const mcpUrl = `${resolveIssuer({ headers: h })}/mcp`;
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

  const me = await identityFromCookies(await cookies(), isSecureHeaders(h));
  const nonce = h.get(CONSENT_NONCE_HEADER) ?? ''; // missing → the /me routes refuse (fail closed)
  const rawError = sp.login_error;
  const loginError = loginErrorText((Array.isArray(rawError) ? rawError[0] : rawError) ?? ''); // fixed codes only (R-22)

  if (!me) {
    return (
      <main style={{ maxWidth: 520, margin: '0 auto', padding: '48px 24px 80px' }}>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Meine KI-Zugänge</h1>
        <p style={muted}>Melde dich mit deinem normalen Wiki-Login an, um deine Verbindungen zu sehen.</p>
        {loginError ? <ErrorBox text={loginError} /> : null}
        <div style={card}>
          <form method="post" action="/me/login">
            <Csrf nonce={nonce} />
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

  const { listSessionsForUser, listActiveSessions, listAudit } = await import('../../lib/oauth/store');
  const sessions = listSessionsForUser(me.identity.id, me.identity.email);
  // "Active" = still usable; idle- or age-expired sessions are not (R-44).
  const active = sessions.filter((s) => isSessionActive(s));
  const ended = sessions.length - active.length;
  // Admin section: gated by Wiki.js' own permission model (users.list probe).
  const admin = await isWikiAdmin(me.jwt);
  const allActive = admin ? listActiveSessions().filter((s) => isSessionActive(s)) : [];
  const audit = admin ? listAudit(30) : [];

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 80px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Meine KI-Zugänge</h1>
      {/* div, not p: a <form> inside <p> is invalid HTML and breaks hydration. */}
      <div style={muted}>
        Angemeldet als <strong style={emphasis}>{me.identity.name}</strong> ({me.identity.email})
        {me.source === 'wiki-cookie' ? ' — über deine Wiki-Sitzung.' : '.'}
        {me.source === 'me-cookie' ? (
          <form method="post" action="/me/logout" style={{ display: 'inline', marginLeft: 8 }}>
            <Csrf nonce={nonce} />
            <button type="submit" style={quietBtn}>Abmelden</button>
          </form>
        ) : null}
      </div>

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
                <th style={th}><span style={srOnly}>Aktion</span></th>
              </tr>
            </thead>
            <tbody>
              {active.map((s) => (
                <tr key={s.id}>
                  <td style={td}>{s.clientName}</td>
                  <td style={td}><Time ts={s.createdAt} /></td>
                  <td style={td}><Time ts={s.lastUsedAt} /></td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <RevokeButton sessionId={s.id} clientName={s.clientName} nonce={nonce} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ended > 0 ? (
          <p style={{ ...muted, fontSize: 13, marginBottom: 0 }}>{ended} beendete oder abgelaufene Verbindung(en) werden nicht angezeigt.</p>
        ) : null}
      </div>

      <p style={{ ...muted, fontSize: 13 }}>
        Ein Widerruf wirkt sofort: Der Client verliert den Zugriff und muss neu autorisiert werden. Deine Rechte im
        Wiki selbst bleiben unverändert.
      </p>

      {admin ? (
        <>
          <div style={adminCard}>
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
                    <th style={th}><span style={srOnly}>Aktion</span></th>
                  </tr>
                </thead>
                <tbody>
                  {allActive.map((s) => (
                    <tr key={s.id}>
                      <td style={td}>{s.userLabel} <span style={{ ...muted, fontSize: 12 }}>({s.userEmail})</span></td>
                      <td style={td}>{s.clientName}</td>
                      <td style={td}><Time ts={s.lastUsedAt} /></td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <RevokeButton sessionId={s.id} clientName={s.clientName} person={s.userLabel} nonce={nonce} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={adminCard}>
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
                      <td style={td}><Time ts={a.ts} /></td>
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
