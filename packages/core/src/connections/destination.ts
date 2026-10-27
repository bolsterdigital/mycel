// Where a webhook may point: public HTTPS on 443 whose every DNS answer is a public address.
// Checked at configuration (the use cases) and again before each send (the transport), both
// through the core DNS port so in-memory tests see the same rule. Pure code, because the core
// may not import `node:net` (ADR 001). Rejected: a validator callback inside the db repository,
// which hid the lookup from in-memory tests and ran it untyped inside the write.
import { UseCaseError } from '../errors.js';
import { DnsUnavailableError, type DnsResolver } from '../tenants/ports.js';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4(address: string): number | null {
  const m = IPV4.exec(address);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** Eight 16-bit groups; null for anything else, including an embedded dotted IPv4 tail. */
function ipv6(address: string): number[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(address)) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (all.some((g) => g.length < 1 || g.length > 4)) return null;
  return all.map((g) => parseInt(g, 16));
}

// Special-purpose IPv4 space (RFC 6890 and successors) that a webhook must never reach.
const BLOCKED_V4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const inV4 = (value: number, [base, bits]: [string, number]) =>
  bits === 0 || value >>> (32 - bits) === ipv4(base)! >>> (32 - bits);

/** Only global unicast: IPv6 inside 2000::/3 minus documentation, Teredo, 6to4 and 3fff::/20. */
export function publicAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4 !== null) return !BLOCKED_V4.some((range) => inV4(v4, range));
  const v6 = ipv6(address);
  if (!v6) return false;
  const [a, b] = [v6[0]!, v6[1]!];
  if (a >> 13 !== 0b001) return false;
  if (a === 0x2001 && (b === 0 || b === 0x0db8)) return false;
  if (a === 0x2002) return false;
  if (a === 0x3fff && b >> 12 === 0) return false;
  return true;
}

/** The checked URL and the first public answer, which the transport pins for TCP. */
export async function checkDestination(
  dns: Pick<DnsResolver, 'addresses'>,
  raw: string
): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UseCaseError('invalid_input', 'invalid webhook destination');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    host.startsWith('[') ||
    ipv4(host) !== null ||
    !host.includes('.') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  )
    throw new UseCaseError('invalid_input', 'webhook destination must be public HTTPS on port 443');
  let addresses: string[];
  try {
    addresses = await dns.addresses(host);
  } catch (e) {
    if (e instanceof DnsUnavailableError)
      throw new UseCaseError('invalid_input', 'webhook destination DNS unavailable');
    throw e;
  }
  if (!addresses.length || addresses.some((address) => !publicAddress(address)))
    throw new UseCaseError('invalid_input', 'webhook destination DNS is not public');
  return { url, address: addresses[0]! };
}
