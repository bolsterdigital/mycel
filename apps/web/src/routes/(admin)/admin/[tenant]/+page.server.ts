// One page per tenant (brief #7 decision 11): members and API keys, managed through the same use
// cases HTTP and MCP expose, with native form posts. A new key's token is in the response to the
// post that made it and nowhere else: reloading the page does not show it again.
import { fail, type ActionFailure } from '@sveltejs/kit';
import {
  Capability,
  KeyCapability,
  UseCaseError,
  useCases,
  type Principal,
  type UseCaseErrorCode,
} from '@mycel/core';
import { requireTenantPrincipal } from '#lib/server/admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { UiKey } from '../../../../i18n/index.js';
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

type Failure = ActionFailure<{ action: string; error: UiKey; email?: string }>;

const statusOf: Record<UseCaseErrorCode, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

/** Run one action as the operator; a UseCaseError becomes a form failure with catalog copy. */
async function act<T>(
  event: { locals: App.Locals; url: URL; params: { tenant: string }; request: Request },
  action: string,
  conflict: UiKey,
  fn: (principal: Principal, data: FormData) => Promise<T>
): Promise<T | Failure> {
  const { principal } = await requireTenantPrincipal(event.locals, event.url, event.params.tenant);
  const data = await event.request.formData();
  try {
    return await fn(principal, data);
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    const error: UiKey =
      e.code === 'conflict'
        ? conflict
        : e.code === 'not_found'
          ? 'admin.error.notFound'
          : e.code === 'forbidden'
            ? 'admin.error.forbidden'
            : 'admin.error.invalid';
    return fail(statusOf[e.code], { action, error, email: text(data, 'email') });
  }
}

const text = (data: FormData, name: string) => {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
};
const capabilities = (data: FormData) => data.getAll('capabilities').map(String);

export const actions: Actions = {
  invite: (event) =>
    act(event, 'invite', 'admin.error.inviteConflict', async (principal, data) => {
      const member = await runtime().invoker.run(useCases.inviteMember, principal, {
        email: text(data, 'email'),
        capabilities: capabilities(data) as Capability[],
      });
      return { action: 'invite', done: 'admin.done.invited' as UiKey, email: member.email };
    }),
  update: (event) =>
    act(event, 'update', 'admin.error.lastAdmin', async (principal, data) => {
      const r = await runtime().invoker.run(useCases.updateMember, principal, {
        operatorId: text(data, 'operatorId'),
        capabilities: capabilities(data) as Capability[],
      });
      return { action: 'update', done: 'admin.done.updated' as UiKey, revokedKeys: r.revokedKeys };
    }),
  remove: (event) =>
    act(event, 'remove', 'admin.error.lastAdmin', async (principal, data) => {
      const r = await runtime().invoker.run(useCases.removeMember, principal, {
        operatorId: text(data, 'operatorId'),
      });
      return { action: 'remove', done: 'admin.done.removed' as UiKey, revokedKeys: r.revokedKeys };
    }),
  createKey: (event) =>
    act(event, 'createKey', 'admin.error.invalid', async (principal, data) => {
      const name = text(data, 'name');
      const key = await runtime().invoker.run(useCases.createKey, principal, {
        name,
        capabilities: capabilities(data) as KeyCapability[],
      });
      return { action: 'createKey', token: key.token, keyName: name };
    }),
  revokeKey: (event) =>
    act(event, 'revokeKey', 'admin.error.notFound', async (principal, data) => {
      await runtime().invoker.run(useCases.revokeKey, principal, { id: text(data, 'id') });
      return { action: 'revokeKey', done: 'admin.done.revoked' as UiKey };
    }),
};
