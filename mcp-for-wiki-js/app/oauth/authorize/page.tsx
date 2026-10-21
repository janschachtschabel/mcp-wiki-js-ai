import { cookies, headers } from 'next/headers';
import { oauthEnabled } from '../../../lib/oauth/store';
import { resolveIssuer } from '../../../lib/oauth/metadata';
import { authorizeErrorText, loginErrorText } from '../../../lib/oauth/messages';
import { OAuthError, validateAuthorizeRequest, validateResource, type AuthorizeParams } from '../../../lib/oauth/service';
import { CONSENT_NONCE_HEADER, identityFromCookies, isSecureHeaders } from '../../../lib/oauth/web';
import { card, emphasis, input, label, link, muted, primaryBtn, secondaryBtn, warningBox } from '../../theme';
import { ErrorBox } from '../../ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Wiki-Zugriff freigeben' };

/**
 * OAuth authorize page. The "login" here IS the Wiki.js login:
 *  - If the browser already carries a valid wiki `jwt` cookie (same-domain
 *    deployment) → one-click consent, no typing.
 *  - Otherwise a username/password form, validated against Wiki.js' own
 *    login mutation (+ a second 2FA step when the account requires it).
 * All decisions POST to /oauth/authorize/decision (same-origin enforced) and
 * carry the CSRF nonce that proxy.ts minted for this render (cookie + field).
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
    resource: first(sp, 'resource') || undefined,
  };
}

function HiddenParams({ p, mode, nonce }: { p: AuthorizeParams; mode: string; nonce: string }) {
  return (
    <>
      <input type="hidden" name="csrf" value={nonce} />
      <input type="hidden" name="client_id" value={p.clientId} />
      <input type="hidden" name="redirect_uri" value={p.redirectUri} />
      <input type="hidden" name="code_challenge" value={p.codeChallenge} />
      <input type="hidden" name="code_challenge_method" value={p.codeChallengeMethod} />
      {p.state ? <input type="hidden" name="state" value={p.state} /> : null}
      {p.resource ? <input type="hidden" name="resource" value={p.resource} /> : null}
      <input type="hidden" name="mode" value={mode} />
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

  const h = await headers();
  const sp = await searchParams;
  const p = paramsFrom(sp);
  const responseType = first(sp, 'response_type') || 'code';
  let clientName: string;
  try {
    if (responseType !== 'code') throw new OAuthError('invalid_request', 'Only response_type=code is supported.');
    clientName = validateAuthorizeRequest(p).name;
    validateResource(p.resource, resolveIssuer({ headers: h }));
  } catch (e) {
    // NEVER redirect to an unvalidated redirect_uri — render the error instead.
    return (
      <Frame>
        <div style={card}>
          <h2 style={{ fontSize: 17 }}>Anfrage abgelehnt</h2>
          <p role="alert" style={muted}>{authorizeErrorText(e)}</p>
        </div>
      </Frame>
    );
  }

  const tfaStep = first(sp, 'step') === 'tfa'; // continuation is in an HttpOnly cookie (R-26)
  const loginError = loginErrorText(first(sp, 'login_error')); // fixed codes only (R-22)
  const forceLogin = first(sp, 'force_login') === '1';
  const sso = tfaStep || forceLogin ? undefined : await identityFromCookies(await cookies(), isSecureHeaders(h));
  const nonce = h.get(CONSENT_NONCE_HEADER) ?? ''; // missing → the decision route refuses (fail closed)

  return (
    <Frame>
      <p style={muted}>
        <strong style={emphasis}>{clientName}</strong> möchte über den MCP-Server auf das Wiki zugreifen —
        mit deinen Wiki-Rechten, in deinem Namen.
      </p>
      <div role="note" style={warningBox}>
        <strong>Nicht verifizierte Anwendung.</strong> Den Namen „{clientName}“ hat die Anwendung bei der
        Registrierung selbst gewählt — er beweist nicht, wer sie ist. Verlässlich ist nur das Ziel:
        <br />
        Nach der Freigabe geht es weiter zu: <strong style={emphasis}>{redirectTarget(p.redirectUri)}</strong>
        <br />
        Erlaube den Zugriff nur, wenn du die Verbindung gerade selbst gestartet hast und das Ziel kennst.
      </div>

      {loginError ? <ErrorBox text={loginError} /> : null}

      {sso ? (
        <div style={card}>
          <p style={{ marginTop: 0 }}>
            Angemeldet als <strong>{sso.identity.name}</strong>{' '}
            <span style={muted}>({sso.identity.email})</span>
          </p>
          <form method="post" action="/oauth/authorize/decision" style={{ display: 'inline' }}>
            <HiddenParams p={p} mode="consent" nonce={nonce} />
            <button type="submit" name="action" value="allow" style={primaryBtn}>
              Zugriff erlauben
            </button>
            <button type="submit" name="action" value="deny" style={secondaryBtn}>
              Ablehnen
            </button>
          </form>
          <p style={{ ...muted, fontSize: 13, marginBottom: 0 }}>
            Nicht du? <a href={`?${new URLSearchParams({ ...flatten(sp), force_login: '1' })}`} style={link}>Mit anderem Wiki-Konto anmelden</a>
          </p>
        </div>
      ) : tfaStep ? (
        <div style={card}>
          <form method="post" action="/oauth/authorize/decision">
            <HiddenParams p={p} mode="tfa" nonce={nonce} />
            <label style={label} htmlFor="security_code">
              Zwei-Faktor-Code (Authenticator-App)
            </label>
            <input style={input} id="security_code" name="security_code" inputMode="numeric" autoComplete="one-time-code" required />
            <button type="submit" name="action" value="allow" style={primaryBtn}>
              Bestätigen &amp; erlauben
            </button>
            <button type="submit" name="action" value="deny" style={secondaryBtn} formNoValidate>
              Ablehnen
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
            <HiddenParams p={p} mode="credentials" nonce={nonce} />
            <label style={label} htmlFor="username">E-Mail / Benutzername</label>
            <input style={input} id="username" name="username" autoComplete="username" required />
            <label style={label} htmlFor="password">Passwort</label>
            <input style={input} id="password" name="password" type="password" autoComplete="current-password" required />
            <button type="submit" name="action" value="allow" style={primaryBtn}>
              Anmelden &amp; erlauben
            </button>
            {/* formNoValidate: refusing must not require filling in the login fields (R-49). */}
            <button type="submit" name="action" value="deny" style={secondaryBtn} formNoValidate>
              Ablehnen
            </button>
          </form>
        </div>
      )}

      <p style={{ ...muted, fontSize: 13 }}>
        Du kannst den Zugriff jederzeit unter <a href="/me" style={link}>/me</a> widerrufen.
      </p>
    </Frame>
  );
}

/** Who receives the authorization code — the registered client name is caller-chosen, the target is not. */
function redirectTarget(redirectUri: string): string {
  const host = new URL(redirectUri).hostname; // already validated by validateAuthorizeRequest
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) ? `${host} (Programm auf diesem Rechner)` : host;
}

function flatten(sp: Search): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string') out[k] = s;
  }
  return out;
}
