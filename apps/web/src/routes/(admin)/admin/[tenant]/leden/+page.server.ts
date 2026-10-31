// Members (#81 PR 1, #101): who works on this site and in which role. Managed through the same
// use cases HTTP and MCP expose (brief #7 decision 11), with native form posts; a role picker
// posts a role, which lib/server/admin/roles.ts turns into the capability set the use cases have
// always taken, so `requires` and their inputs are unchanged. API keys moved to Settings, API
// access (#101: "members" are people). A refusal by an entitlement or a suspension is a message
// that names what, never a price (ADR 015 rule 3); the mapping lives in
// lib/server/admin/admin-actions.ts.
import { Capability, Role, useCases } from '@mycel/core';
import { act, text } from '#lib/server/admin/admin-actions.js';
import { postedCapabilities } from '#lib/server/admin/roles.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../../i18n/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const { invoker, config } = runtime();
  const { members } = await invoker.run(useCases.listMembers, locals.principal!, {});
  return {
    members,
    roles: Role.options,
    allCapabilities: Capability.options,
    loginUrl: `${config.PUBLIC_BASE_URL}/admin`,
  };
};

export const actions: Actions = {
  invite: (event) =>
    act(event, 'invite', { conflict: 'admin.error.inviteConflict' }, async (principal, data) => {
      const member = await runtime().invoker.run(useCases.inviteMember, principal, {
        email: text(data, 'email'),
        capabilities: postedCapabilities(data) as Capability[],
      });
      return { action: 'invite', done: 'admin.done.invited' as UiKey, email: member.email };
    }),
  update: (event) =>
    act(event, 'update', { conflict: 'admin.error.lastAdmin' }, async (principal, data) => {
      const r = await runtime().invoker.run(useCases.updateMember, principal, {
        operatorId: text(data, 'operatorId'),
        capabilities: postedCapabilities(data) as Capability[],
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
};
