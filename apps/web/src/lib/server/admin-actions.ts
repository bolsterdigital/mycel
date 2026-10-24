// The form-action plumbing every admin page shares: run one use case as the operator and turn a
// UseCaseError into a form failure with catalog copy. A refusal by an entitlement or a
// suspension names what was refused, never a price (ADR 015 rule 3). Moved here from the tenant
// page when the media page (TODO #10b) became the second user. Rejected: a copy per page, which
// lets the error mapping of two admin pages drift apart.
import { fail, type ActionFailure } from '@sveltejs/kit';
import { UseCaseError, type Principal, type UseCaseErrorCode } from '@mycel/core';
import { requireTenantPrincipal } from './admin.js';
import type { UiKey } from '../../i18n/index.js';

export type Failure = ActionFailure<{
  action: string;
  error: UiKey;
  what?: UiKey;
  email?: string;
  hostname?: string;
  id?: string;
  filename?: string;
  n?: number;
}>;

export interface ActionEvent {
  locals: App.Locals;
  url: URL;
  params: { tenant: string };
  request: Request;
}

/** Catalog copy per outcome; `issues` maps the i18n key core put in the first issue. */
export interface ActionCopy {
  conflict: UiKey;
  invalid?: UiKey;
  notFound?: UiKey;
  issues?: Record<string, UiKey>;
}

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
  'entitlements.limit.media.storage_max_bytes': 'admin.limit.what.storage',
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

export const text = (data: FormData, name: string) => {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
};

/**
 * Run one action as the operator; a UseCaseError becomes a form failure with catalog copy.
 * `details` adds values to a failure (the usage count of media that is in use).
 */
export async function act<T>(
  event: ActionEvent,
  action: string,
  copy: ActionCopy,
  fn: (principal: Principal, data: FormData) => Promise<T>,
  details?: (
    e: UseCaseError,
    principal: Principal,
    data: FormData
  ) => Promise<Record<string, string | number>>
): Promise<T | Failure> {
  const { principal } = await requireTenantPrincipal(event.locals, event.url, event.params.tenant);
  const data = await event.request.formData();
  try {
    return await fn(principal, data);
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    const extra = {
      email: text(data, 'email'),
      hostname: text(data, 'hostname'),
      id: text(data, 'id'),
      ...(details ? await details(e, principal, data) : {}),
    };
    const { status, body } = failureOf(e, action, copy);
    return fail(status, { ...body, ...extra });
  }
}

/**
 * The status and catalog copy of a UseCaseError, for an action that builds its own failure (the
 * content admin re-renders a whole form from the posted values).
 */
export function failureOf(
  e: UseCaseError,
  action: string,
  copy: ActionCopy
): { status: number; body: { action: string; error: UiKey; what?: UiKey } } {
  const status = statusOf[e.code];
  if (e.code === 'limit_exceeded') return { status, body: { action, ...limitFailure(e, action) } };
  if (e.code === 'suspended') return { status, body: { action, error: 'admin.error.suspended' } };
  const issue = copy.issues?.[e.issues[0]?.message ?? ''];
  const error: UiKey =
    e.code === 'conflict'
      ? copy.conflict
      : e.code === 'not_found'
        ? (copy.notFound ?? 'admin.error.notFound')
        : e.code === 'forbidden'
          ? 'admin.error.forbidden'
          : (issue ?? copy.invalid ?? 'admin.error.invalid');
  return { status, body: { action, error } };
}
