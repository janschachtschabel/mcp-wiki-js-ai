/**
 * Browser-facing texts of the OAuth pages (German, like the pages).
 *
 * Errors travel through redirects as FIXED codes only (`login_error=<code>`):
 * the page renders the text for a known code and nothing for anything else,
 * so a crafted link cannot put its own wording on our login page (R-22).
 * Upstream messages never reach the browser (R-23) — they are logged instead.
 */

import { OAuthError } from './service';

const LOGIN_ERRORS = {
  invalid_credentials: 'Benutzername oder Passwort ist falsch.',
  account_disabled: 'Dieses Wiki-Konto ist deaktiviert.',
  account_unverified: 'Dieses Wiki-Konto ist noch nicht bestätigt — bitte zuerst die Bestätigungs-E-Mail des Wikis öffnen.',
  password_change_required: 'Das Wiki verlangt eine Passwortänderung — bitte zuerst direkt im Wiki anmelden.',
  tfa_setup_required: 'Das Wiki verlangt die Einrichtung der Zwei-Faktor-Anmeldung — bitte zuerst direkt im Wiki anmelden.',
  tfa_failed: 'Der Zwei-Faktor-Code war falsch. Bitte erneut mit Passwort anmelden.',
  tfa_expired: 'Der Zwei-Faktor-Schritt ist abgelaufen oder gehört zu einer anderen Anfrage. Bitte erneut anmelden.',
  rate_limited: 'Zu viele Anmeldeversuche — bitte einige Minuten warten und dann erneut versuchen.',
  unavailable: 'Das Wiki ist gerade nicht erreichbar — bitte später erneut versuchen.',
  session_expired: 'Deine Wiki-Sitzung ist abgelaufen — bitte anmelden.',
  me_tfa: 'Dein Konto nutzt Zwei-Faktor-Anmeldung: Melde dich einmal im Wiki selbst an (gleicher Browser) und öffne diese Seite erneut.',
  failed: 'Anmeldung fehlgeschlagen — bitte erneut versuchen.',
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERRORS;

/** The text for a known code; undefined for anything else (then nothing is shown). */
export function loginErrorText(code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code as LoginErrorCode] : undefined;
}

const AUTHORIZE_ERRORS: Record<OAuthError['code'], string> = {
  invalid_client: 'Diese Anwendung ist hier nicht registriert (unbekannte client_id).',
  invalid_redirect_uri: 'Die Rücksprungadresse (redirect_uri) ist für diese Anwendung nicht registriert oder nicht erlaubt.',
  invalid_request: 'Die Anfrage ist unvollständig: PKCE mit code_challenge_method=S256 und response_type=code sind erforderlich.',
  invalid_target: 'Die Anfrage nennt eine Ressource, die nicht zu diesem Server gehört (Parameter resource).',
  invalid_grant: 'Die Anfrage ist ungültig.',
  unsupported_grant_type: 'Die Anfrage ist ungültig.',
};

/** German text for a rejected authorization request (the API keeps the English OAuth texts). */
export function authorizeErrorText(e: unknown): string {
  return e instanceof OAuthError ? AUTHORIZE_ERRORS[e.code] : 'Ungültige Autorisierungs-Anfrage.';
}
