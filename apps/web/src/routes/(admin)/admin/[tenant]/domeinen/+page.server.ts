// The site's hostnames (TODO #14), moved verbatim from the tenant home when it became the
// dashboard (#66 PR 1); dev turns it into its own screen in #81. Hostnames are stored as punycode
// and shown in Unicode next to it. A refusal by an entitlement or a suspension is a message that
// names what, never a price (ADR 015 rule 3); the mapping lives in lib/server/admin-actions.ts.
import { domainToUnicode } from 'node:url';
import { useCases, type VerifyResult } from '@mycel/core';
import { act, text } from '#lib/server/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const principal = locals.principal!;
  const { invoker } = runtime();
  const { hostnames } = await invoker.run(useCases.listHostnames, principal, {});
  return {
    hostnames: hostnames.map((h) => ({ ...h, display: domainToUnicode(h.hostname) })),
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
        const rt = runtime();
        const added = await rt.invoker.run(useCases.addHostname, principal, {
          hostname: text(data, 'hostname'),
        });
        rt.sites.invalidate(added.hostname);
        return {
          action: 'addHostname',
          done: 'admin.domains.done.added' as UiKey,
          hostname: added.hostname,
        };
      }
    ),
  verifyHostname: (event) =>
    act(
      event,
      'verifyHostname',
      { conflict: 'admin.error.notFound', notFound: 'admin.domains.error.notFound' },
      async (principal, data) => {
        const rt = runtime();
        const verify: VerifyResult = await rt.invoker.run(useCases.verifyHostname, principal, {
          hostname: text(data, 'hostname'),
        });
        rt.sites.invalidate(verify.hostname);
        return { action: 'verifyHostname', verify };
      }
    ),
  setPrimaryHostname: (event) =>
    act(
      event,
      'setPrimaryHostname',
      { conflict: 'admin.domains.error.notVerified', notFound: 'admin.domains.error.notFound' },
      async (principal, data) => {
        const rt = runtime();
        const h = await rt.invoker.run(useCases.setPrimaryHostname, principal, {
          hostname: text(data, 'hostname'),
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
        const r = await rt.invoker.run(useCases.removeHostname, principal, {
          hostname: text(data, 'hostname'),
        });
        rt.sites.invalidate(r.hostname);
        return {
          action: 'removeHostname',
          done: 'admin.domains.done.removed' as UiKey,
          hostname: r.hostname,
        };
      }
    ),
};
