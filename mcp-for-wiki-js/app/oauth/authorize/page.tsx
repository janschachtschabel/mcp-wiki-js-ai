import { cookies } from 'next/headers';
import { oauthEnabled } from '../../../lib/oauth/store';
import { OAuthError, validateAuthorizeRequest, type AuthorizeParams } from '../../../lib/oauth/service';
import { identityFromCookies } from '../../../lib/oauth/web';
import { card, input, label, muted, primaryBtn, secondaryBtn } from '../../theme';

export const dynamic = 'force-dynamic';

/**
 * OAuth authorize page. The "login" here IS the Wiki.js login:
 *  - If the browser already carries a valid wiki `jwt` cookie (same-domain
 *    deployment) → one-click consent, no typing.
 *  - Otherwise a username/password form, validated against Wiki.js' own
 *    login mutation (+ a second 2FA step when the account requires it).
 * All decisions POST to /oauth/authorize/decision (same-origin enforced).
 */

type Search = Record<string, string | string[] | undefined>;

function first(sp: Search, key: string): string {
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

function paramsFrom(sp: Search): AuthorizeParams {
  return {
    clientId: first(sp, 'client_id'),
    redirectUri: first(sp, 'redirect_uri'),
    codeChallenge: first(sp, 'code_challenge'),
    codeChallengeMethod: first(sp, 'code_challenge_method'),
    state: first(sp, 'state') || undefined,
  };
}

function HiddenParams({ p, mode, tfa }: { p: AuthorizeParams; mode: string; tfa?: string }) {
  return (
    <>
      <input type="hidden" name="client_id" value={p.clientId} />
      <input type="hidden" name="redirect_uri" value={p.redirectUri} />
      <input type="hidden" name="code_challenge" value={p.codeChallenge} />
      <input type="hidden" name="code_challenge_method" value={p.codeChallengeMethod} />
      {p.state ? <input type="hidden" name="state" value={p.state} /> : null}
      <input type="hidden" name="mode" value={mode} />
      {tfa ? <input type="hidden" name="tfa" value={tfa} /> : null}
    </>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 520, margin: '0 auto', padding: '48px 24px 80px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Wiki-Zugriff freigeben</h1>
      {children}
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Search> }) {
  if (!oauthEnabled()) {
    return (
      <Frame>
        <div style={card}>
          <p style={muted}>OAuth ist auf diesem Deployment nicht aktiviert (MCP_SESSION_SECRET fehlt).</p>
        </div>
      </Frame>
    );
  }

  const sp = await searchParams;
  const p = paramsFrom(sp);
  const responseType = first(sp, 'response_type') || 'code';
  let clientName: string;
  try {
    if (responseType !== 'code') throw new OAuthError('invalid_request', 'Only response_type=code is supported.');
    clientName = validateAuthorizeRequest(p).name;
  } catch (e) {
    // NEVER redirect to an unvalidated redirect_uri — render the error instead.
    const msg = e instanceof OAuthError ? e.message : 'Ungültige Autorisierungs-Anfrage.';
    return (
      <Frame>
        <div style={card}>
          <h2 style={{ fontSize: 17 }}>Anfrage abgelehnt</h2>
          <p style={muted}>{msg}</p>
        </div>
      </Frame>
    );
  }

  const tfa = first(sp, 'tfa'); // encrypted continuation token (2FA second step)
  const loginError = first(sp, 'login_error').slice(0, 200);
  const forceLogin = first(sp, 'force_login') === '1';
  const sso = tfa || forceLogin ? undefined : await identityFromCookies(await cookies());

  return (
    <Frame>
      <p style={muted}>
        <strong style={{ color: '#e7ecff' }}>{clientName}</strong> möchte über den MCP-Server auf das Wiki zugreifen —
        mit deinen Wiki-Rechten, in deinem Namen.
      </p>

      {loginError ? (
        <div style={{ ...card, border: '1px solid #7f1d1d', background: '#2a1420' }}>
          <p style={{ color: '#fca5a5', margin: 0 }}>{loginError}</p>
        </div>
      ) : null}

      {sso ? (
        <div style={card}>
          <p style={{ marginTop: 0 }}>
            Angemeldet als <strong>{sso.identity.name}</strong>{' '}
            <span style={muted}>({sso.identity.email})</span>
          </p>
          <form method="post" action="/oauth/authorize/decision" style={{ display: 'inline' }}>
            <HiddenParams p={p} mode="consent" />
            <button type="submit" name="action" value="allow" style={primaryBtn}>
              Zugriff erlauben
            </button>
            <button type="submit" name="action" value="deny" style={secondaryBtn}>
              Ablehnen
            </button>
          </form>
          <p style={{ ...muted, fontSize: 13, marginBottom: 0 }}>
            Nicht du? <a href={`?${new URLSearchParams({ ...flatten(sp), force_login: '1' })}`} style={{ color: '#7ab3ff' }}>Mit anderem Wiki-Konto anmelden</a>
          </p>
        </div>
      ) : tfa ? (
        <div style={card}>
          <form method="post" action="/oauth/authorize/decision">
            <HiddenParams p={p} mode="tfa" tfa={tfa} />
            <label style={label} htmlFor="security_code">
              Zwei-Faktor-Code (Authenticator-App)
            </label>
            <input style={input} id="security_code" name="security_code" inputMode="numeric" autoComplete="one-time-code" required />
            <button type="submit" name="action" value="allow" style={primaryBtn}>
              Bestätigen &amp; erlauben
            </button>
          </form>
        </div>
      ) : (
        <div style={card}>
          <p style={{ ...muted, marginTop: 0, fontSize: 14 }}>
            Mit deinem normalen <strong>Wiki-Login</strong> anmelden (das Passwort wird nur an das Wiki
            durchgereicht, nie gespeichert):
          </p>
          <form method="post" action="/oauth/authorize/decision">
            <HiddenParams p={p} mode="credentials" />
            <label style={label} htmlFor="username">E-Mail / Benutzername</label>
            <input style={input} id="username" name="username" autoComplete="username" required />
            <label style={label} htmlFor="password">Passwort</label>
            <input style={input} id="password" name="password" type="password" autoComplete="current-password" required />
            <button type="submit" name="action" value="allow" style={primaryBtn}>
              Anmelden &amp; erlauben
            </button>
            <button type="submit" name="action" value="deny" style={secondaryBtn}>
              Ablehnen
            </button>
          </form>
        </div>
      )}

      <p style={{ ...muted, fontSize: 13 }}>
        Du kannst den Zugriff jederzeit unter <a href="/me" style={{ color: '#7ab3ff' }}>/me</a> widerrufen.
      </p>
    </Frame>
  );
}

function flatten(sp: Search): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string') out[k] = s;
  }
  return out;
}
