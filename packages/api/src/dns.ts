// DNS adapter for hostname verification (TODO #14, brief decision 6): the `DnsResolver` port over
// `node:dns/promises`. It lives here and not in packages/db because it is not database access;
// the composition root already hosts the other small adapter the core needs (signer.ts), and
// the core itself may not import `node:dns` (ADR 001: no I/O libraries).
//
// A missing name (`ENOTFOUND`, `ENODATA`) is an ordinary "not found": the admin has simply not
// created the record yet. Timeouts and server failures propagate, so the admin sees an error
// instead of a false "not found". Five seconds, two tries: a slow authoritative server must not
// hang an admin's form post. Rejected: `dns.lookup`, which goes through the OS resolver and its
// hosts file and cannot ask for TXT records.

import { Resolver } from 'node:dns/promises';
import type { DnsResolver } from '@mycel/core';

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'ESERVFAIL']);

export function createDnsResolver({ timeoutMs = 5000 } = {}): DnsResolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  const notFound = (e: unknown) => NOT_FOUND.has((e as { code?: string }).code ?? '');
  return {
    async txt(name) {
      try {
        // Each record is an array of character strings; concatenation is what the RFC means.
        return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
      } catch (e) {
        if (notFound(e)) return [];
        throw e;
      }
    },
    async cname(name) {
      try {
        return (await resolver.resolveCname(name))[0]?.replace(/\.$/, '').toLowerCase() ?? null;
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
  };
}
