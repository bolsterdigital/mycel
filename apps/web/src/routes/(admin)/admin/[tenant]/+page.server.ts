// One page per tenant (brief #7 decision 11): members, API keys and, since TODO #14, the site's
// hostnames, managed through the same use cases HTTP and MCP expose, with native form posts. A
// new key's token is in the response to the post that made it and nowhere else: reloading the
// page does not show it again. Hostnames are stored as punycode and shown in Unicode next to it.
// Since TODO #16 it shows usage against the limits, and a refusal by an entitlement or a
// suspension as a message that names what, never a price (ADR 015 rule 3); the mapping lives in
// lib/server/admin-actions.ts. Media has its own page (TODO #10b), linked from here.
import { domainToUnicode } from 'node:url';
import { Capability, KeyCapability, useCases, type VerifyResult } from '@mycel/core';
import { act, text } from '#lib/server/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const principal = locals.principal!;
  const { invoker, config } = runtime();
  const [{ members }, { keys }, { hostnames }, usage] = await Promise.all([
    invoker.run(useCases.listMembers, principal, {}),
    invoker.run(useCases.listKeys, principal, {}),
    invoker.run(useCases.listHostnames, principal, {}),
    invoker.run(useCases.getUsage, principal, {}),
  ]);
  return {
    usage,
    members,
    keys,
    hostnames: hostnames.map((h) => ({ ...h, display: domainToUnicode(h.hostname) })),
    allCapabilities: Capability.options,
    keyCapabilities: KeyCapability.options,
    loginUrl: `${config.PUBLIC_BASE_URL}/admin`,
  };
};

const capabilities = (data: FormData) => data.getAll('capabilities').map(String);

export const actions: Actions = {
  invite: (event) =>
    act(event, 'invite', { conflict: 'admin.error.inviteConflict' }, async (principal, data) => {
      const member = await runtime().invoker.run(useCases.inviteMember, principal, {
        email: text(data, 'email'),
        capabilities: capabilities(data) as Capability[],
      });
      return { action: 'invite', done: 'admin.done.invited' as UiKey, email: member.email };
    }),
  update: (event) =>
    act(event, 'update', { conflict: 'admin.error.lastAdmin' }, async (principal, data) => {
      const r = await runtime().invoker.run(useCases.updateMember, principal, {
        operatorId: text(data, 'operatorId'),
        capabilities: capabilities(data) as Capability[],
      });
      return { action: 'update', done: 'admin.done.updated' as UiKey, revokedKeys: r.revokedKeys };
    }),
  remove: (event) =>
    act(event, 'remove', { conflict: 'admin.error.lastAdmin' }, async (principal, data) => {
      const r = await runtime().invoker.run(useCases.removeMember, principal, {
        operatorId: text(data, 'operatorId'),
      });
      return { action: 'remove', done: 'admin.done.removed' as UiKey, revokedKeys: r.revokedKeys };
    }),
  createKey: (event) =>
    act(event, 'createKey', { conflict: 'admin.error.invalid' }, async (principal, data) => {
      const name = text(data, 'name');
      const key = await runtime().invoker.run(useCases.createKey, principal, {
        name,
        capabilities: capabilities(data) as KeyCapability[],
      });
      return { action: 'createKey', token: key.token, keyName: name };
    }),
  revokeKey: (event) =>
    act(event, 'revokeKey', { conflict: 'admin.error.notFound' }, async (principal, data) => {
      await runtime().invoker.run(useCases.revokeKey, principal, { id: text(data, 'id') });
      return { action: 'revokeKey', done: 'admin.done.revoked' as UiKey };
    }),

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
