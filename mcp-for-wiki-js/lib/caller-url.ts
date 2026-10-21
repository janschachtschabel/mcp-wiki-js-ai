import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * Address ranges a caller-chosen wiki URL must not point at in pure multi-tenant
 * BYOK mode (audit R-14b): this server would otherwise fetch internal services on
 * the caller's behalf (SSRF), e.g. cloud metadata at 169.254.169.254.
 */
const INTERNAL = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this host" — 0.0.0.0 reaches loopback on Linux
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, used for internal cloud endpoints
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local incl. cloud metadata
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking, used inside some provider networks
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast 255.255.255.255
] as const) {
  INTERNAL.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local, still routed internally by some stacks
] as const) {
  INTERNAL.addSubnet(net, prefix, 'ipv6');
}

/** Host names that never denote a public wiki: `localhost`, mDNS, cloud/Docker internals. */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal'];

const REFUSED =
  'X-Wikijs-Url points to a loopback, private, link-local or internal address — refused (an operator can allow it via WIKIJS_ALLOWED_URLS).';

/** The 8 hex groups of an IPv6 address in WHATWG URL serialisation (hex only, at most one `::`). */
function ipv6Groups(host: string): number[] {
  const [head, tail] = host.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The IPv4 address embedded in an IPv4-mapped (::ffff:0:0/96), IPv4-compatible
 * (::/96) or NAT64 (64:ff9b::/96) IPv6 address — `::7f00:1` → `127.0.0.1`.
 * These reach the embedded IPv4 host, so they are checked against the IPv4 list.
 */
function embeddedIpv4(host: string): string | undefined {
  const g = ipv6Groups(host);
  const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if (!mapped && !nat64) return undefined;
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
}

/** Normalise an IP literal the way the WHATWG URL parser does (IPv6: compressed hex, no zone). */
function normalizeIp(address: string): string {
  if (isIP(address) !== 6) return address;
  const bare = address.replace(/%.*$/, ''); // a DNS answer may carry a zone id (fe80::1%eth0)
  return new URL(`http://[${bare}]`).hostname.slice(1, -1);
}

function internalIp(host: string): boolean {
  if (isIP(host) === 4) return INTERNAL.check(host, 'ipv4');
  if (isIP(host) !== 6) return false;
  const v4 = embeddedIpv4(host);
  return v4 ? INTERNAL.check(v4, 'ipv4') : INTERNAL.check(host, 'ipv6');
}

/** A host name (not an IP) that can only mean something on an internal network. */
function internalName(host: string): boolean {
  if (isIP(host) !== 0) return false;
  return !host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s));
}

/** Parse an http(s) URL and return its normalised host (no IPv6 brackets, no trailing root dot). */
function hostOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('X-Wikijs-Url is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('X-Wikijs-Url must be an http(s) URL.');
  }
  // URL normalises decimal/hex IPv4 forms; strip IPv6 brackets and a trailing root dot.
  return parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/**
 * Throw unless `url` is an http(s) URL whose host is neither an internal IP
 * literal (loopback, private, link-local, …) nor an internal-only name
 * (`localhost`, a name without a dot, `*.localhost`, `*.local`, `*.internal`).
 * Synchronous: runs when the credential is resolved. What a public-looking name
 * RESOLVES to is checked per request by assertPublicTarget.
 */
export function assertPublicUrl(url: string): string {
  const host = hostOf(url);
  if (internalName(host) || internalIp(host)) throw new Error(REFUSED);
  return url;
}

/**
 * Throw unless every address `url`'s host resolves to is public. The WikiClient of
 * a caller-chosen URL in pure BYOK mode runs this before EVERY request, so a name
 * like 169.254.169.254.nip.io — or one whose record changed since the last request
 * — is refused before anything is sent.
 *
 * simplify: DNS rebinding is narrowed, not closed. fetch() resolves the name again
 * on connect, so a record that flips between this lookup and that connect (TTL 0)
 * still slips through. Closing it needs a connect-time pin (a custom undici
 * dispatcher whose lookup checks the address) — deliberately not added (no new
 * dependency). Operators who need a hard boundary set WIKIJS_URL / WIKIJS_ALLOWED_URLS.
 */
export async function assertPublicTarget(url: string): Promise<void> {
  const host = hostOf(url);
  if (internalName(host)) throw new Error(REFUSED);
  if (isIP(host) !== 0) {
    if (internalIp(host)) throw new Error(REFUSED);
    return;
  }
  // Looked up through the module object so tests can stub it (no real DNS there).
  const answers = await dns.promises.lookup(host, { all: true });
  if (answers.length === 0 || answers.some((a) => internalIp(normalizeIp(a.address)))) {
    throw new Error(
      'X-Wikijs-Url host resolves to an internal address — refused (an operator can allow it via WIKIJS_ALLOWED_URLS).',
    );
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Neither WIKIJS_URL nor WIKIJS_ALLOWED_URLS is set: callers choose the wiki (pure multi-tenant BYOK). */
export function pureByok(env: Record<string, string | undefined>): boolean {
  return !(env.WIKIJS_URL || env.WIKIJS_BASE_URL || '').trim() && !(env.WIKIJS_ALLOWED_URLS || '').split(',').some((u) => u.trim());
}

/**
 * A caller-supplied wiki URL (X-Wikijs-Url / ?url=) is honoured only if its origin
 * is allow-listed (WIKIJS_ALLOWED_URLS) or equals WIKIJS_URL — otherwise anonymous
 * callers could make this server fetch arbitrary internal addresses (SSRF).
 * With neither configured, the deployment is pure multi-tenant BYOK: any PUBLIC
 * http(s) URL is accepted, internal addresses and names are refused (audit R-14b);
 * the caller's WikiClient then re-checks the resolved addresses (assertPublicTarget).
 *
 * A server-side key (KEY_MAP alias, env service token) is only ever sent to
 * WIKIJS_URL — never to a URL the caller picked, even an allow-listed one (R-14a).
 */
export function checkCallerUrl(url: string, env: Record<string, string | undefined>, serverKey: boolean): string {
  const configured = (env.WIKIJS_URL || env.WIKIJS_BASE_URL || '').trim();
  if (serverKey) {
    const origin = originOf(url);
    if (origin !== undefined && origin === originOf(configured)) return url;
    throw new Error('X-Wikijs-Url is not allowed with a server-side credential — that key is only sent to WIKIJS_URL.');
  }
  if (pureByok(env)) return assertPublicUrl(url);
  const allowed = (env.WIKIJS_ALLOWED_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const origin = originOf(url);
  const permitted = [configured, ...allowed].filter(Boolean).map(originOf);
  if (origin === undefined || !permitted.includes(origin)) {
    throw new Error('X-Wikijs-Url is not allowed on this server (see WIKIJS_ALLOWED_URLS).');
  }
  return url;
}
