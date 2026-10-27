// DNS adapter for hostname verification (TODO #14, brief decision 6): the `DnsResolver` port over
// `node:dns/promises`. It lives here and not in packages/db because it is not database access;
// the composition root already hosts the other small adapter the core needs (signer.ts), and
// the core itself may not import `node:dns` (ADR 001: no I/O libraries).
//
// A missing name (`ENOTFOUND`, `ENODATA`) is an ordinary "not found": the admin has simply not
// created the record yet. A server failure, a refusal or a time-out is `DnsUnavailableError`:
// DNS gave no answer, so nothing may be concluded from it, neither by the admin's check nor by
// the daily re-check that counts misses (TODO #15). Anything else propagates. Five seconds, two
// tries: a slow authoritative server must not hang an admin's form post. Rejected: `dns.lookup`,
// which goes through the OS resolver and its hosts file and cannot ask for TXT records.

import { Resolver } from 'node:dns/promises';
import { DnsUnavailableError, type DnsResolver } from '@mycel/core';

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA']);
const NO_ANSWER = new Set(['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED']);

export function createDnsResolver({
  timeoutMs = 5000,
  resolver = new Resolver({ timeout: timeoutMs, tries: 2 }),
}: {
  timeoutMs?: number;
  /** Tests pass a stand-in; production uses the system's DNS servers. */
  resolver?: Pick<Resolver, 'resolveTxt' | 'resolveCname' | 'resolve4' | 'resolve6'>;
} = {}): DnsResolver {
  const code = (e: unknown) => (e as { code?: string }).code ?? '';
  /** Map a resolver error to "not found", or throw what it means. */
  const missing = <T>(e: unknown, empty: T): T => {
    if (NOT_FOUND.has(code(e))) return empty;
    if (NO_ANSWER.has(code(e))) throw new DnsUnavailableError(`DNS did not answer (${code(e)})`);
    throw e;
  };
  return {
    async txt(name) {
      try {
        // Each record is an array of character strings; concatenation is what the RFC means.
        return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
      } catch (e) {
        return missing(e, []);
      }
    },
    async cname(name) {
      try {
        return (await resolver.resolveCname(name))[0]?.replace(/\.$/, '').toLowerCase() ?? null;
      } catch (e) {
        return missing(e, null);
      }
    },
    async addresses(name) {
      // Both families, each "missing" on its own: a host with only AAAA is ordinary. No answer
      // from either side is DnsUnavailableError, as for TXT and CNAME.
      const [v4, v6] = await Promise.all([
        resolver.resolve4(name).catch((e: unknown) => missing<string[]>(e, [])),
        resolver.resolve6(name).catch((e: unknown) => missing<string[]>(e, [])),
      ]);
      return [...v4, ...v6];
    },
  };
}
