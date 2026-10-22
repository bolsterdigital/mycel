// One page per tenant (brief #7 decision 11): members, API keys and, since TODO #14, the site's
// hostnames, managed through the same use cases HTTP and MCP expose, with native form posts. A
// new key's token is in the response to the post that made it and nowhere else: reloading the
// page does not show it again. Hostnames are stored as punycode and shown in Unicode next to it.
// Since TODO #16 it shows usage against the limits, and a refusal by an entitlement or a
// suspension as a message that names what, never a price (ADR 015 rule 3).
import { domainToUnicode } from 'node:url';
import { fail, type ActionFailure } from '@sveltejs/kit';
import {
  Capability,
  KeyCapability,
  UseCaseError,
  useCases,
  type Principal,
  type UseCaseErrorCode,
  type VerifyResult,
} from '@mycel/core';
import { requireTenantPrincipal } from '#lib/server/admin.js';
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

type Failure = ActionFailure<{
  action: string;
  error: UiKey;
  what?: UiKey;
  email?: string;
  hostname?: string;
}>;

const statusOf: Record<UseCaseErrorCode, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  limit_exceeded: 403,
  suspended: 403,
};

/** What a `limit_exceeded` refused, from the i18n key core put in its issue. */
const LIMIT_WHAT: Record<string, UiKey> = {
  'entitlements.limit.supporters.max': 'admin.limit.what.supporters',
  'entitlements.limit.operators.max': 'admin.limit.what.operators',
  'entitlements.limit.custom_domains.max': 'admin.limit.what.customDomains',
};
const FEATURE_WHAT: Record<string, UiKey> = {
  createKey: 'admin.limit.what.apiKeys',
  addHostname: 'admin.limit.what.customDomains',
};

function limitFailure(e: UseCaseError, action: string): { error: UiKey; what: UiKey } {
  const key = e.issues[0]?.message ?? '';
  return key === 'entitlements.feature_off'
    ? { error: 'admin.limit.featureOff', what: FEATURE_WHAT[action] ?? 'admin.limit.what.other' }
    : { error: 'admin.limit.reached', what: LIMIT_WHAT[key] ?? 'admin.limit.what.other' };
}

/** Run one action as the operator; a UseCaseError becomes a form failure with catalog copy. */
async function act<T>(
  event: { locals: App.Locals; url: URL; params: { tenant: string }; request: Request },
  action: string,
  copy: { conflict: UiKey; invalid?: UiKey; notFound?: UiKey },
  fn: (principal: Principal, data: FormData) => Promise<T>
): Promise<T | Failure> {
  const { principal } = await requireTenantPrincipal(event.locals, event.url, event.params.tenant);
  const data = await event.request.formData();
  try {
    return await fn(principal, data);
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    const extra = { email: text(data, 'email'), hostname: text(data, 'hostname') };
    if (e.code === 'limit_exceeded')
      return fail(statusOf[e.code], { action, ...limitFailure(e, action), ...extra });
    if (e.code === 'suspended')
      return fail(statusOf[e.code], { action, error: 'admin.error.suspended' as UiKey, ...extra });
    const error: UiKey =
      e.code === 'conflict'
        ? copy.conflict
        : e.code === 'not_found'
          ? (copy.notFound ?? 'admin.error.notFound')
          : e.code === 'forbidden'
            ? 'admin.error.forbidden'
            : (copy.invalid ?? 'admin.error.invalid');
    return fail(statusOf[e.code], { action, error, ...extra });
  }
}

const text = (data: FormData, name: string) => {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
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
