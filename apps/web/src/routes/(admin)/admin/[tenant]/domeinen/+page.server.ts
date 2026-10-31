// The site's hostnames (TODO #14), moved verbatim from the tenant home when it became the
// dashboard (#66 PR 1); dev turns it into its own screen in #81. Hostnames are stored as punycode
// and shown in Unicode next to it. A refusal by an entitlement or a suspension is a message that
// names what, never a price (ADR 015 rule 3); the mapping lives in lib/server/admin/admin-actions.ts.
// A pasted URL becomes its hostname before the use case (#102, lib/server/admin/hostname.ts).
// An organisation's main domain is added as its bare and its www name in one go and shown as one
// card (#115, lib/admin/domain-pairs.ts): the card's form carries both names, so checking and
// removing act on both, and "use as the address" names one with its own button value.
import { domainToUnicode } from 'node:url';
import { useCases, type Principal, type VerifyResult } from '@mycel/core';
import { act, text } from '#lib/server/admin/admin-actions.js';
import { pastedHostname } from '#lib/server/admin/hostname.js';
import { domainEntries, mainDomainNames } from '#lib/admin/domain-pairs.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const principal = locals.principal!;
  const { invoker } = runtime();
  const { hostnames } = await invoker.run(useCases.listHostnames, principal, {});
  return {
    entries: domainEntries(hostnames.map((h) => ({ ...h, display: domainToUnicode(h.hostname) }))),
  };
};

export const actions: Actions = {
  // Hostnames (TODO #14). After a change the site directory forgets the hostname at once, so
  // the public side does not serve a stale answer for the rest of its cache window.
  addHostname: (event) =>
    act(
      event,
      'addHostname',
      { conflict: 'admin.domains.error.conflict', invalid: 'admin.domains.error.invalid' },
      async (principal, data) => {
        const typed = pastedHostname(text(data, 'hostname'));
        if (text(data, 'scope') !== 'main') {
          const added = await add(principal, typed);
          return {
            action: 'addHostname',
            done: 'admin.domains.done.added' as UiKey,
            hostname: added,
          };
        }
        // Both names or neither: when the www name cannot be added (in use, over the limit),
        // the bare name added a moment ago goes again, so a half pair never stays behind. Two
        // use cases, not one, because each is what an agent would call over MCP as well.
        const { apex, www } = mainDomainNames(typed);
        const added = await add(principal, apex);
        try {
          await add(principal, www);
        } catch (e) {
          await runtime().invoker.run(useCases.removeHostname, principal, { hostname: added });
          runtime().sites.invalidate(added);
          throw e;
        }
        return {
          action: 'addHostname',
          done: 'admin.domains.done.addedPair' as UiKey,
          hostname: added,
        };
      },
      // The form opens again with the kind of domain the operator chose.
      async (_e, _principal, data) => ({ scope: text(data, 'scope') })
    ),
  verifyHostname: (event) =>
    act(
      event,
      'verifyHostname',
      { conflict: 'admin.error.notFound', notFound: 'admin.domains.error.notFound' },
      async (principal, data) => {
        const rt = runtime();
        // A main domain's card checks both of its names.
        const verifies: VerifyResult[] = [];
        for (const hostname of names(data)) {
          const verify = await rt.invoker.run(useCases.verifyHostname, principal, { hostname });
          rt.sites.invalidate(verify.hostname);
          verifies.push(verify);
        }
        return { action: 'verifyHostname', verifies };
      }
    ),
  setPrimaryHostname: (event) =>
    act(
      event,
      'setPrimaryHostname',
      { conflict: 'admin.domains.error.notVerified', notFound: 'admin.domains.error.notFound' },
      async (principal, data) => {
        const rt = runtime();
        // A main domain's card names the chosen name on the button; a single card in its field.
        const h = await rt.invoker.run(useCases.setPrimaryHostname, principal, {
          hostname: text(data, 'primary') || text(data, 'hostname'),
        });
        rt.sites.invalidate();
        return {
          action: 'setPrimaryHostname',
          done: 'admin.domains.done.primary' as UiKey,
          hostname: h.hostname,
        };
      }
    ),
  removeHostname: (event) =>
    act(
      event,
      'removeHostname',
      { conflict: 'admin.domains.error.isPrimary', notFound: 'admin.domains.error.notFound' },
      async (principal, data) => {
        const rt = runtime();
        // A main domain goes with both names; the screen offers this only when neither is the
        // site's address, so the use case's refusal of the primary is the exception here.
        const removed: string[] = [];
        for (const hostname of names(data)) {
          const r = await rt.invoker.run(useCases.removeHostname, principal, { hostname });
          rt.sites.invalidate(r.hostname);
          removed.push(r.hostname);
        }
        return {
          action: 'removeHostname',
          done: 'admin.domains.done.removed' as UiKey,
          hostname: removed.join(', '),
        };
      }
    ),
};

/** Add one custom hostname and forget it in the site directory; returns the stored name. */
async function add(principal: Principal, hostname: string): Promise<string> {
  const rt = runtime();
  const added = await rt.invoker.run(useCases.addHostname, principal, { hostname });
  rt.sites.invalidate(added.hostname);
  return added.hostname;
}

/** The card's hostnames: one for a single name, both for a main domain. */
const names = (data: FormData): string[] =>
  data
    .getAll('hostname')
    .map((v) => String(v).trim())
    .filter(Boolean);
