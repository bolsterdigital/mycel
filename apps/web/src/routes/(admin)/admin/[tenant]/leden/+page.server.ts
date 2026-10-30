// Members, invitations, API keys and the operator's own capabilities, moved verbatim from the
// tenant home when it became the dashboard (#66 PR 1); dev turns it into its own screen in #81.
// Managed through the same use cases HTTP and MCP expose (brief #7 decision 11), with native form
// posts. A new key's token is in the response to the post that made it and nowhere else:
// reloading the page does not show it again. A refusal by an entitlement or a suspension is a
// message that names what, never a price (ADR 015 rule 3); the mapping lives in
// lib/server/admin/admin-actions.ts.
import { Capability, KeyCapability, useCases } from '@mycel/core';
import { act, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const principal = locals.principal!;
  const { invoker, config } = runtime();
  const [{ members }, { keys }] = await Promise.all([
    invoker.run(useCases.listMembers, principal, {}),
    invoker.run(useCases.listKeys, principal, {}),
  ]);
  return {
    members,
    keys,
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
};
