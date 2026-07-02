/**
 * Thin wrappers around Wiki.js' own authentication GraphQL — the OAuth layer
 * never stores passwords; it exchanges them (or an existing browser session
 * cookie) for a Wiki.js user JWT and keeps only that, encrypted.
 *
 * Wiki.js rate-limits login/loginTFA at 5/min per its schema (@rateLimit),
 * which doubles as brute-force protection for our authorize endpoint.
 */

import { WikiClient, WikiConnectionError } from '../wikijs/client';

export interface WikiIdentity {
  name: string;
  email: string;
}

export type LoginOutcome =
  | { kind: 'ok'; jwt: string }
  | { kind: 'tfa'; continuationToken: string }
  | { kind: 'error'; message: string };

interface LoginResponseShape {
  authentication: {
    login?: LoginPayload;
    loginTFA?: LoginPayload;
  };
}
interface LoginPayload {
  responseResult?: { succeeded: boolean; message?: string | null };
  jwt?: string | null;
  mustProvideTFA?: boolean | null;
  mustSetupTFA?: boolean | null;
  mustChangePwd?: boolean | null;
  continuationToken?: string | null;
}

const LOGIN_FIELDS =
  'responseResult { succeeded message } jwt mustProvideTFA mustSetupTFA mustChangePwd continuationToken';

/**
 * Login errors are shown in the user's browser. Wiki.js' own auth errors
 * ("Invalid credentials", …) are user-appropriate; transport failures are not —
 * their messages contain the INTERNAL wiki endpoint. Log details server-side,
 * show a generic line to the browser.
 */
function browserSafeError(e: unknown, action: string): LoginOutcome {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof WikiConnectionError || /timed out/i.test(message)) {
    console.error(`${action} against Wiki.js failed:`, message);
    return { kind: 'error', message: 'Das Wiki ist gerade nicht erreichbar — bitte später erneut versuchen.' };
  }
  return { kind: 'error', message };
}

function toOutcome(p: LoginPayload | undefined, action: string): LoginOutcome {
  if (!p) return { kind: 'error', message: `${action}: empty response from Wiki.js.` };
  if (p.mustProvideTFA && p.continuationToken) return { kind: 'tfa', continuationToken: p.continuationToken };
  if (p.responseResult?.succeeded && p.jwt) return { kind: 'ok', jwt: p.jwt };
  if (p.mustChangePwd) {
    return { kind: 'error', message: 'Wiki.js requires a password change — log in to the wiki in your browser first.' };
  }
  if (p.mustSetupTFA) {
    return { kind: 'error', message: 'Wiki.js requires 2FA setup — log in to the wiki in your browser first.' };
  }
  return { kind: 'error', message: p.responseResult?.message || `${action} failed.` };
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
    return browserSafeError(e, 'Login');
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
    return browserSafeError(e, '2FA verification');
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
    const data = await client.request<{ users: { profile: { name: string; email: string } | null } }>(
      'query { users { profile { name email } } }',
    );
    const p = data.users.profile;
    return p ? { name: p.name, email: p.email } : undefined;
  } catch {
    return undefined;
  }
}
