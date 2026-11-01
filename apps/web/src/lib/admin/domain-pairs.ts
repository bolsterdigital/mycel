// A site's own domain usually answers on two names, `example.org` and `www.example.org`, one of
// which is the address and the other redirects (#115). Mycel stores them as two ordinary custom
// hostnames: the 301 from a verified non-primary name and the certificate for every verified name
// already exist (ADR 014, lib/server/site.ts). What is added here is only how the admin screen
// adds and shows them: an organisation's main domain is added as both names at once and shown
// as one card, a separate subdomain as one name.
// Rejected: a stored "pair" or "preferred variant" (a migration for what the two rows already
// say; the choice of address is the existing primary, made once both names work) and telling a
// main domain from a subdomain by its labels (`campaign.example.org` and `example.co.uk` both
// have three; without the public suffix list a guess, so the operator says which it is).

/** The two names of a main domain, from what the operator typed with or without `www.`. */
export function mainDomainNames(hostname: string): { apex: string; www: string } {
  const apex = hostname.replace(/^www\./, '');
  return { apex, www: `www.${apex}` };
}

type Named = { hostname: string; kind: 'platform' | 'custom' };

/** One card on the domains screen: a single hostname, or a main domain with its www name. */
export type DomainEntry<H extends Named> =
  { kind: 'single'; hostname: H } | { kind: 'pair'; apex: H; www: H };

/**
 * Group the hostnames into cards in list order: a custom `example.org` and a custom
 * `www.example.org` on the same site are one pair, wherever each stands in the list; everything
 * else is a card of its own. Hostnames added one by one before #115 pair the same way.
 */
export function domainEntries<H extends Named>(hostnames: readonly H[]): DomainEntry<H>[] {
  const custom = new Map(hostnames.filter((h) => h.kind === 'custom').map((h) => [h.hostname, h]));
  const paired = new Set<string>();
  const entries: DomainEntry<H>[] = [];
  for (const h of hostnames) {
    if (paired.has(h.hostname)) continue;
    if (h.kind === 'custom') {
      const { apex, www } = mainDomainNames(h.hostname);
      const a = custom.get(apex);
      const w = custom.get(www);
      if (a && w && a !== w) {
        paired.add(apex).add(www);
        entries.push({ kind: 'pair', apex: a, www: w });
        continue;
      }
    }
    entries.push({ kind: 'single', hostname: h });
  }
  return entries;
}
