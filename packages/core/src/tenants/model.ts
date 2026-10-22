// Hostnames of a tenant (ADR 014, TODO #14). A tenant lives on one or more hostnames: the
// platform hostname `<slug>.<platform domain>` it gets at creation, and custom domains its admin
// adds, proves control of (a TXT record) and makes primary. Everything here is pure: the
// normalisation, the rules of what a custom hostname may be, and the DNS instruction an admin
// has to carry out. Storage is always the ASCII (punycode) form; a front shows the Unicode form.
//
// Rejected: validating with a hand-written IDNA table (the WHATWG URL parser, a platform
// standard in Node and browsers, already does IDNA and rejects what is not a hostname), and
// verifying through an HTTP path on the domain (needs DNS to point at us first, so a site could
// never be prepared before the switch; a TXT record proves control without moving traffic).

import { z } from 'zod';
import { UseCaseError } from '../errors.js';

export const HostnameKind = z.enum(['platform', 'custom']);
export type HostnameKind = z.infer<typeof HostnameKind>;

/** The records an admin creates at their DNS provider for a custom hostname. */
export const DnsInstruction = z.object({
  txt: z.object({ name: z.string(), value: z.string() }),
  /** A CNAME is the normal case; an apex domain uses A/AAAA records the hoster documents. */
  cname: z.object({ name: z.string(), target: z.string() }),
});
export type DnsInstruction = z.infer<typeof DnsInstruction>;

/** A hostname as the list shows it: ASCII form, never the verification token. */
export const Hostname = z.object({
  hostname: z.string(),
  kind: HostnameKind,
  primary: z.boolean(),
  verifiedAt: z.string().datetime().nullable(),
  /** Custom hostnames only: what to set at the DNS provider. */
  dns: DnsInstruction.optional(),
});
export type Hostname = z.infer<typeof Hostname>;

/** Longest hostname DNS carries; labels are at most 63 characters each. */
const MAX_LENGTH = 253;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const invalid = (why: string) =>
  new UseCaseError('invalid_input', `hostname ${why}`, [{ path: 'hostname', message: why }]);

/**
 * Trim, lowercase, drop a trailing dot, and turn an internationalised name into punycode.
 * Refuses a port, a path, an IP address, more than 253 characters and labels outside
 * `[a-z0-9-]`. The result is what is stored and compared.
 */
export function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) throw invalid('is empty');
  if (/[\s/\\?#@:]/.test(trimmed)) throw invalid('contains a port, a path or other characters');
  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    throw invalid('is not a valid domain name');
  }
  const hostname = url.hostname;
  // A different `host` means the parser saw a port, credentials or a path; `[` is IPv6.
  if (url.host !== hostname || url.pathname !== '/' || hostname.startsWith('['))
    throw invalid('contains a port, a path or other characters');
  if (IPV4.test(hostname)) throw invalid('is an IP address, not a domain name');
  if (hostname.length > MAX_LENGTH) throw invalid('is longer than 253 characters');
  for (const label of hostname.split('.'))
    if (!LABEL.test(label)) throw invalid(`has an invalid label "${label}"`);
  return hostname;
}

/** True when `hostname` is `domain` itself or a subdomain of it. */
export const underDomain = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`);

/**
 * A custom hostname is anything a tenant may bring: never the platform domain or a subdomain of
 * it (those are platform hostnames, made at tenant creation), and never a development host.
 */
export function normalizeCustomHostname(
  raw: string,
  platform: { domain: string; devHosts: readonly string[] }
): string {
  const hostname = normalizeHostname(raw);
  if (underDomain(hostname, platform.domain))
    throw invalid(`cannot be under the platform domain ${platform.domain}`);
  if (platform.devHosts.includes(hostname)) throw invalid('is a development host');
  return hostname;
}

/** The platform hostname of a tenant: `<slug>.<platform domain>`. */
export const platformHostname = (slug: string, platformDomain: string): string =>
  `${slug}.${platformDomain}`;

/** Name of the TXT record that proves control of a hostname (decision 6 of brief #14). */
export const verificationRecord = (hostname: string): string => `_mycel-verify.${hostname}`;

export function dnsInstruction(
  hostname: string,
  token: string,
  slug: string,
  platformDomain: string
): DnsInstruction {
  return {
    txt: { name: verificationRecord(hostname), value: token },
    cname: { name: hostname, target: platformHostname(slug, platformDomain) },
  };
}
