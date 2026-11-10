// A profile update never sends `status`. Suppression changes require a separately selected
// resubscription operation and new confirmation evidence. Unknown effects are only read back.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  normalizeEmail,
  mailchimpTarget,
  active,
  connectionIntentGuard,
  formFeedSource,
  FormFeedPayload,
  applyMailchimpObservation,
  isSyntheticIntent,
  systemPrincipal,
  type Clock,
  type ConnectionTransport,
  type UnitOfWork,
  type TransactionContext,
  type IdentityStore,
} from '@mycel/core';
import { Member, mailchimpServer, requestMailchimp, type MailchimpRequest } from './client.js';

export const mailchimpMemberHash = (email: string) =>
  createHash('md5').update(normalizeEmail(email)).digest('hex');
const sameFields = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.entries(b).every(([key, value]) => JSON.stringify(a[key]) === JSON.stringify(value));
type DispatchInput = Parameters<ConnectionTransport['dispatch']>[0];
function prepared(input: DispatchInput) {
  const target = mailchimpTarget(input.connection.destination);
  if (!target || mailchimpServer(input.credential) !== target.server) return null;
  const feed = FormFeedPayload.safeParse(input.payload);
  if (!feed.success) return null;
  const { fields, consent } = feed.data.data;
  const email = z.string().email().safeParse(fields['email']);
  if (!email.success || consent.owner !== input.connection.consentAuthority) return null;
  if (consent.owner === 'mycel' && !consent.confirmedAt) return null;
  const merge = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'email'));
  if (Object.keys(merge).some((key) => !/^[A-Z][A-Z0-9_]{0,9}$/.test(key))) return null;
  const hash = mailchimpMemberHash(email.data);
  return {
    target,
    email: email.data,
    merge,
    consent,
    hash,
    path: `/lists/${target.audience}/members/${hash}`,
  };
}
export interface MailchimpTransportDeps {
  uow: UnitOfWork;
  identity: Pick<IdentityStore, 'tenantAccess'>;
  clock: Clock;
  request?: MailchimpRequest;
}
export function mailchimpTransport({
  uow,
  identity,
  clock,
  request = requestMailchimp,
}: MailchimpTransportDeps): ConnectionTransport & {
  sync(tenantId: string, intentId: string): Promise<boolean>;
} {
  const run = async <T>(
    tenantId: string,
    fn: (ctx: TransactionContext) => Promise<T>
  ): Promise<T> =>
    uow.run(
      systemPrincipal(tenantId, 'connections.run', await identity.tenantAccess(tenantId)),
      fn
    );
  const observe = async (input: DispatchInput, member: Member | null) => {
    await run(input.tenantId, async (ctx) => {
      // Recheck the kill switch and versions after the provider read, before local mutation.
      const connection = await ctx.connections.get(input.connection.id);
      if (
        !active(ctx.principal) ||
        !connection ||
        connection.state !== 'active' ||
        connection.version !== input.intent.connectionVersion ||
        connection.credentialVersion !== input.intent.credentialVersion
      )
        return;
      await applyMailchimpObservation(ctx, input.intent, {
        status: member?.status ?? 'absent',
        changedAt: member ? new Date(member.last_changed) : clock.now(),
        optAt:
          member?.timestamp_opt && !Number.isNaN(Date.parse(member.timestamp_opt))
            ? new Date(member.timestamp_opt)
            : null,
      });
    });
  };
  const reconcile = async (input: DispatchInput): Promise<'succeeded' | 'unknown'> => {
    const p = prepared(input);
    if (!p) return 'unknown';
    const result = await request({
      server: p.target.server,
      credential: input.credential,
      method: 'GET',
      path: p.path,
    });
    if (result.status !== 200) return 'unknown';
    const member = Member.safeParse(result.body);
    if (!member.success || normalizeEmail(member.data.email_address) !== normalizeEmail(p.email))
      return 'unknown';
    await observe(input, member.data);
    await run(input.tenantId, (ctx) =>
      ctx.jobs.enqueue({
        type: 'connections.mailchimp.sync',
        key: `connections.mailchimp.sync:${input.intent.id}`,
        runAt: new Date(clock.now().getTime() + 3600_000),
        payload: { intentId: input.intent.id },
      })
    );
    // A read can prove the intended state now. It cannot prove absence of a still-running write,
    // so this transport never returns `absent` and never authorizes another ambiguous write.
    const wanted = p.consent.owner === 'external' ? ['pending', 'subscribed'] : ['subscribed'];
    return wanted.includes(member.data.status) && sameFields(member.data.merge_fields, p.merge)
      ? 'succeeded'
      : 'unknown';
  };
  return {
    reconcile,
    async dispatch(input) {
      if (input.connection.provider !== 'mailchimp') return 'pre_send';
      const target = mailchimpTarget(input.connection.destination);
      if (!target || mailchimpServer(input.credential) !== target.server) return 'pre_send';
      if (isSyntheticIntent(input.intent)) {
        // A synthetic rehearsal cannot put even a test address on a marketing audience.
        const result = await request({
          ...target,
          credential: input.credential,
          method: 'GET',
          path: `/lists/${target.audience}`,
        });
        return result.status === 200 ? 'succeeded' : 'pre_send';
      }
      const p = prepared(input);
      if (!p || !input.intent.supporterId) return 'pre_send';
      const call = (method: 'GET' | 'PUT' | 'PATCH', body?: unknown) =>
        request({
          server: p.target.server,
          credential: input.credential,
          method,
          path: p.path,
          ...(body === undefined ? {} : { body }),
        });
      let prior;
      try {
        prior = await call('GET');
      } catch {
        return 'pre_send';
      }
      if (prior.status !== 200 && prior.status !== 404) return 'pre_send';
      const before = prior.status === 200 ? Member.safeParse(prior.body) : null;
      if (
        before &&
        (!before.success || normalizeEmail(before.data.email_address) !== normalizeEmail(p.email))
      )
        return 'pre_send';
      const member = before?.success ? before.data : null;
      const inserted = await run<boolean>(input.tenantId, (ctx) =>
        ctx.mailchimpReceipts.insert({
          intentId: input.intent.id,
          connectionId: input.connection.id,
          supporterId: input.intent.supporterId!,
          memberHash: p.hash,
          baselineStatus: member?.status ?? 'absent',
          baselineChangedAt: member ? new Date(member.last_changed) : null,
          requestedAt: clock.now(),
          status: member?.status ?? 'absent',
          observedAt: clock.now(),
          confirmedAt: null,
          retryable: false,
        })
      );
      // A committed baseline may precede a crashed write. Read, never overwrite it or resend.
      if (!inserted) {
        const receipt = await run<import('@mycel/core').MailchimpReceipt | null>(
          input.tenantId,
          (ctx) => ctx.mailchimpReceipts.get(input.intent.id)
        );
        if (!receipt?.retryable) return reconcile(input);
      }
      const authorized = await run<boolean>(input.tenantId, async (ctx) => {
        if (await connectionIntentGuard(ctx, input.intent)) return false;
        if (!(await formFeedSource.prepare(ctx, input.intent)).ready) return false;
        await ctx.mailchimpReceipts.retryable(input.intent.id, false);
        return true;
      });
      if (!authorized) return 'pre_send';
      const operation = p.consent.operation ?? 'subscribe';
      const status = p.consent.owner === 'external' ? 'pending' : 'subscribed';
      const resubscribe =
        operation === 'resubscribe' &&
        member?.status === 'unsubscribed' &&
        !!p.consent.requestedAt &&
        new Date(p.consent.requestedAt) > new Date(member.last_changed);
      if (operation === 'profile' && !member) return 'pre_send';
      if (
        resubscribe &&
        p.consent.owner === 'mycel' &&
        (!p.consent.confirmedAt ||
          new Date(p.consent.confirmedAt) <= new Date(member!.last_changed))
      )
        return 'pre_send';
      const result = member
        ? await call('PATCH', { merge_fields: p.merge, ...(resubscribe ? { status } : {}) })
        : await call('PUT', {
            email_address: p.email,
            status_if_new: status,
            merge_fields: p.merge,
            ...(p.consent.confirmedAt ? { timestamp_opt: p.consent.confirmedAt } : {}),
          });
      if ([400, 401, 403, 429].includes(result.status)) {
        await run(input.tenantId, (ctx) => ctx.mailchimpReceipts.retryable(input.intent.id, true));
        return 'pre_send';
      }
      if (result.status < 200 || result.status >= 300) return 'unknown';
      const after = Member.safeParse(result.body);
      if (!after.success || normalizeEmail(after.data.email_address) !== normalizeEmail(p.email))
        return 'unknown';
      await observe(input, after.data);
      await run(input.tenantId, (ctx) =>
        ctx.jobs.enqueue({
          type: 'connections.mailchimp.sync',
          key: `connections.mailchimp.sync:${input.intent.id}`,
          runAt: new Date(clock.now().getTime() + 3600_000),
          payload: { intentId: input.intent.id },
        })
      );
      if (!sameFields(after.data.merge_fields, p.merge)) return 'unknown';
      return member && !resubscribe
        ? after.data.status === member.status
          ? 'succeeded'
          : 'unknown'
        : after.data.status === status ||
            (status === 'pending' && after.data.status === 'subscribed')
          ? 'succeeded'
          : 'unknown';
    },
    async sync(tenantId, intentId) {
      const input = await run<DispatchInput | null | 'defer'>(tenantId, async (ctx) => {
        const intent = await ctx.connectionIntents.get(intentId);
        if (!intent?.supporterId || (await ctx.connectionIntents.erased(intent.supporterId)))
          return null;
        const connection = await ctx.connections.get(intent.connectionId);
        if (
          !connection ||
          connection.provider !== 'mailchimp' ||
          connection.state === 'disconnected' ||
          connection.version !== intent.connectionVersion
        )
          return null;
        if (connection.state === 'paused' || !active(ctx.principal)) return 'defer';
        const credential = await ctx.connections.credential(
          connection.id,
          intent.credentialVersion
        );
        const sub = await ctx.submissions.findByFeedBusinessId(intent.businessId);
        const receipt = await ctx.mailchimpReceipts.get(intent.id);
        const supporter = await ctx.supporters.getProjectionById(intent.supporterId);
        if (
          !credential ||
          !sub ||
          !receipt ||
          !supporter ||
          mailchimpMemberHash(supporter.email) !== receipt.memberHash
        )
          return null;
        if (!(await ctx.rateLimits.hit('mailchimp:comparison', { max: 60, windowSeconds: 60 })))
          return 'defer';
        return { tenantId, intent, connection, credential, payload: {} };
      });
      if (input === 'defer') return true;
      if (!input) return false;
      const target = mailchimpTarget(input.connection.destination);
      const receipt = await run<import('@mycel/core').MailchimpReceipt | null>(tenantId, (ctx) =>
        ctx.mailchimpReceipts.get(intentId)
      );
      if (!target || !receipt) return false;
      const result = await request({
        ...target,
        credential: input.credential,
        method: 'GET',
        path: `/lists/${target.audience}/members/${receipt.memberHash}`,
      });
      if (result.status === 404) await observe(input, null);
      else if (result.status === 200) {
        const parsed = Member.safeParse(result.body);
        if (!parsed.success) throw new Error('Mailchimp comparison response invalid');
        const member = parsed.data;
        if (member.id !== receipt.memberHash) return false;
        await observe(input, member);
      } else throw new Error('Mailchimp comparison unavailable');
      return true;
    },
  };
}
