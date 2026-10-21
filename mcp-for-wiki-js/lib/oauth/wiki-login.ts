/**
 * Thin wrappers around Wiki.js' own authentication GraphQL — the OAuth layer
 * never stores passwords; it exchanges them (or an existing browser session
 * cookie) for a Wiki.js user JWT and keeps only that, encrypted.
 *
 * Wiki.js rate-limits login/loginTFA at 5/min per req.ip — which for form
 * logins through this server is ONE bucket shared by all users. Brute-force
 * and lockout protection therefore lives in ./rate-limit.ts (R-11).
 */

import { WikiClient, WikiConnectionError } from '../wikijs/client';
import type { LoginErrorCode } from './messages';

export interface WikiIdentity {
  /** Wiki.js user id — stable; emails are unique only per auth provider (R-41). */
  id: number;
  name: string;
  email: string;
}

export type LoginOutcome =
  | { kind: 'ok'; jwt: string }
  | { kind: 'tfa'; continuationToken: string }
  | { kind: 'error'; code: LoginErrorCode };

interface LoginResponseShape {
  authentication: {
    login?: LoginPayload;
    loginTFA?: LoginPayload;
  };
}
interface LoginPayload {
  responseResult?: { succeeded: boolean; errorCode?: number | null; message?: string | null };
  jwt?: string | null;
  mustProvideTFA?: boolean | null;
  mustSetupTFA?: boolean | null;
  mustChangePwd?: boolean | null;
  continuationToken?: string | null;
}

const LOGIN_FIELDS =
  'responseResult { succeeded errorCode message } jwt mustProvideTFA mustSetupTFA mustChangePwd continuationToken';

/** Wiki.js error codes (server/helpers/error.js) that the user can act on. */
const WIKI_ERROR_CODES: Record<number, LoginErrorCode> = {
  1002: 'invalid_credentials', // AuthLoginFailed
  1020: 'invalid_credentials', // AuthPasswordInvalid
  1005: 'tfa_failed', // AuthTFAFailed
  1006: 'tfa_failed', // AuthTFAInvalid
  1013: 'account_disabled', // AuthAccountBanned
  1014: 'account_unverified', // AuthAccountNotVerified
};

/**
 * A thrown request error (transport, timeout, non-JSON body, GraphQL error) →
 * a fixed code. The raw message can contain the INTERNAL wiki endpoint or an
 * upstream HTML page: it goes to the server log only (R-23).
 */
function thrownToOutcome(e: unknown, action: string): LoginOutcome {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`${action} against Wiki.js failed:`, message);
  if (/too many requests/i.test(message)) return { kind: 'error', code: 'rate_limited' };
  if (e instanceof WikiConnectionError || /timed out|non-JSON|HTTP \d{3}/i.test(message)) {
    return { kind: 'error', code: 'unavailable' };
  }
  return { kind: 'error', code: 'failed' };
}

function toOutcome(p: LoginPayload | undefined, action: string): LoginOutcome {
  if (!p) {
    console.error(`${action}: empty response from Wiki.js.`);
    return { kind: 'error', code: 'failed' };
  }
  if (p.mustProvideTFA && p.continuationToken) return { kind: 'tfa', continuationToken: p.continuationToken };
  if (p.responseResult?.succeeded && p.jwt) return { kind: 'ok', jwt: p.jwt };
  if (p.mustChangePwd) return { kind: 'error', code: 'password_change_required' };
  if (p.mustSetupTFA) return { kind: 'error', code: 'tfa_setup_required' };
  const code = WIKI_ERROR_CODES[p.responseResult?.errorCode ?? -1];
  if (!code) console.error(`${action} refused by Wiki.js:`, p.responseResult?.message ?? '(no message)');
  return { kind: 'error', code: code ?? 'failed' };
}

/** Username/password → Wiki.js JWT (or a TFA continuation). Uses the built-in "local" strategy. */
export async function loginWithCredentials(baseUrl: string, username: string, password: string): Promise<LoginOutcome> {
  const client = new WikiClient(baseUrl);
  try {
    const data = await client.request<LoginResponseShape>(
      `mutation($u:String!,$p:String!){ authentication { login(username:$u,password:$p,strategy:"local"){ ${LOGIN_FIELDS} } } }`,
      { u: username, p: password },
    );
    return toOutcome(data.authentication.login, 'Login');
  } catch (e) {
    return thrownToOutcome(e, 'Login');
  }
}

/** Second step after loginWithCredentials returned kind:'tfa'. */
export async function loginTfa(baseUrl: string, continuationToken: string, securityCode: string): Promise<LoginOutcome> {
  const client = new WikiClient(baseUrl);
  try {
    const data = await client.request<LoginResponseShape>(
      `mutation($t:String!,$c:String!){ authentication { loginTFA(continuationToken:$t,securityCode:$c){ ${LOGIN_FIELDS} } } }`,
      { t: continuationToken, c: securityCode },
    );
    return toOutcome(data.authentication.loginTFA, '2FA verification');
  } catch (e) {
    return thrownToOutcome(e, '2FA verification');
  }
}

/**
 * Validate a Wiki.js user JWT by fetching the profile it belongs to.
 * Works for fresh logins AND for the browser's `jwt` cookie (SSO path).
 * Returns undefined when the JWT is invalid/expired-beyond-renewal.
 */
export async function fetchIdentity(baseUrl: string, jwt: string): Promise<WikiIdentity | undefined> {
  const client = new WikiClient(baseUrl, jwt);
  try {
    const data = await client.request<{ users: { profile: { id: number; name: string; email: string } | null } }>(
      'query { users { profile { id name email } } }',
    );
    const p = data.users.profile;
    return p ? { id: Number(p.id), name: p.name, email: p.email } : undefined;
  } catch {
    return undefined;
  }
}
