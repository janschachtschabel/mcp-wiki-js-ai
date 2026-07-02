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

const KEY_INFO = 'wikijs-mcp/session-encryption/v1';
const IV_BYTES = 12; // GCM standard nonce size
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;
let cachedSecret: string | null = null;

/** The deployment secret that everything derives from. OAuth is OFF without it. */
export function sessionSecret(env: Record<string, string | undefined> = process.env): string | undefined {
  const s = env.MCP_SESSION_SECRET;
  return s && s.trim().length >= 16 ? s.trim() : undefined;
}

function key(): Buffer {
  const secret = sessionSecret();
  if (!secret) throw new Error('MCP_SESSION_SECRET is not set (min 16 chars) — OAuth session storage is disabled.');
  if (!cachedKey || cachedSecret !== secret) {
    // Static salt is fine here: the secret is already high-entropy deployment
    // config (not a user password); HKDF just shapes it into a 32-byte key.
    cachedKey = Buffer.from(hkdfSync('sha256', secret, 'wikijs-mcp', KEY_INFO, 32));
    cachedSecret = secret;
  }
  return cachedKey;
}

/** AES-256-GCM encrypt; output is base64url(iv | tag | ciphertext). */
export function encryptString(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** Inverse of encryptString. Throws on tampering (GCM auth failure). */
export function decryptString(payload: string): string {
  const raw = Buffer.from(payload, 'base64url');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
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
