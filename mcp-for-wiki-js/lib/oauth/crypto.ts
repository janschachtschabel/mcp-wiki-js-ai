/**
 * Crypto primitives for the OAuth layer.
 *
 * Design constraints:
 *  - Wiki.js user JWTs are stored ENCRYPTED at rest (AES-256-GCM) — a leaked
 *    sqlite file alone must not yield usable credentials.
 *  - Access/refresh tokens and authorization codes are high-entropy random
 *    strings; only their SHA-256 hash is persisted (like password hashing,
 *    but no KDF needed against 256-bit random input).
 *  - Everything comes from node:crypto — no external dependencies.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const IV_BYTES = 12; // GCM standard nonce size
const TAG_BYTES = 16;

/**
 * Every ciphertext is bound to ONE purpose via its own HKDF key (audit R-02):
 * the encrypted wiki JWT in the DB, the browser's mcp_me cookie and the 2FA
 * continuation blob are not interchangeable — a sqlite copy yields no cookie.
 * 'db-jwt' keeps the original derivation so existing sessions survive upgrades.
 */
export type Purpose = 'db-jwt' | 'cookie' | 'tfa';

const KEY_INFO: Record<Purpose, string> = {
  'db-jwt': 'wikijs-mcp/session-encryption/v1',
  cookie: 'wikijs-mcp/me-cookie/v1',
  tfa: 'wikijs-mcp/tfa-continuation/v1',
};

let cachedKeys: Partial<Record<Purpose, Buffer>> = {};
let cachedSecret: string | null = null;

export const MIN_SECRET_LENGTH = 16;

/**
 * The deployment secret that everything derives from. OAuth is OFF without it.
 * Set-but-too-short throws instead of reading as "unset": silently dropping to
 * the unauthenticated legacy path would look like OAuth to the operator (R-07).
 */
export function sessionSecret(env: Record<string, string | undefined> = process.env): string | undefined {
  const s = (env.MCP_SESSION_SECRET ?? '').trim();
  if (!s) return undefined;
  if (s.length < MIN_SECRET_LENGTH) {
    throw new Error(`MCP_SESSION_SECRET is set but shorter than ${MIN_SECRET_LENGTH} characters — refusing to start without OAuth.`);
  }
  return s;
}

/** OAuth is on ⇔ a valid session secret is configured (checked before any store use). */
export function oauthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(sessionSecret(env));
}

function key(purpose: Purpose): Buffer {
  const secret = sessionSecret();
  if (!secret) throw new Error('MCP_SESSION_SECRET is not set (min 16 chars) — OAuth session storage is disabled.');
  if (cachedSecret !== secret) {
    cachedKeys = {};
    cachedSecret = secret;
  }
  // Static salt is fine here: the secret is already high-entropy deployment
  // config (not a user password); HKDF just shapes it into a 32-byte key.
  return (cachedKeys[purpose] ??= Buffer.from(hkdfSync('sha256', secret, 'wikijs-mcp', KEY_INFO[purpose], 32)));
}

/** AES-256-GCM encrypt under the purpose's key; output is base64url(iv | tag | ciphertext). */
export function encryptString(plain: string, purpose: Purpose): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** Inverse of encryptString. Throws on tampering or a different purpose (GCM auth failure). */
export function decryptString(payload: string, purpose: Purpose): string {
  const raw = Buffer.from(payload, 'base64url');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key(purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Random bearer credential with a recognizable prefix (mcp_at_ / mcp_rt_ / mcp_ac_). */
export function newToken(prefix: 'mcp_at_' | 'mcp_rt_' | 'mcp_ac_'): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function newClientId(): string {
  return 'mcp_client_' + randomBytes(16).toString('base64url');
}

/** Hex SHA-256 — storage form of tokens/codes (input is 256-bit random, no KDF needed). */
export function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string equality (for hash comparisons). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** PKCE S256: base64url(SHA-256(verifier)) must equal the stored challenge. */
export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  // RFC 7636: verifier is 43..128 chars of [A-Za-z0-9-._~]
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return safeEqual(pkceChallengeFromVerifier(verifier), challenge);
}
