import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
// The provider fixture runs the real form/feed/intent boundary. Rejected: mocking the source,
// which would miss pending consent, a stale mapping and a withdrawal after acceptance.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  mailchimpTarget,
  DEFAULT_ACCESS,
  FORM_FEED_SOURCE,
  Invoker,
  buildRegistry,
  formFeedSource,
  formFeedSubscriber,
  ingest,
  runConnectionIntent,
  signConfirmToken,
  supporterIngestSubscriber,
  systemPrincipal,
  useCases,
  queueMailchimpCallback,
  type ConnectionIntent,
  type FormFeed,
  type SupporterEvent,
  type WithdrawalEvidence,
} from '@mycel/core';
import { FakeClock, FakeDns, MemoryUnitOfWork, probeForm, TENANT } from '@mycel/core/testing';
import { mailchimpMemberHash, mailchimpTransport } from './transport.js';
import {
  Member as MemberSchema,
  inspectMailchimp,
  type MailchimpRequest,
  type Member,
} from './client.js';
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/mailchimp/${name}.json`, import.meta.url), 'utf8')
  );
const FORM = '01900000-0000-7000-8000-00000000f000';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const credential = `${'a'.repeat(32)}-us7`;
const email = 'visitor@example.org';
const admin = systemPrincipal(TENANT, 'provider-test');

describe('Mailchimp real form feed', () => {
  let clock: FakeClock, uow: MemoryUnitOfWork, invoker: Invoker;
  let connectionId: string, feed: FormFeed, member: Member | null, ambiguous: boolean;
  let reads: number, writes: { method: string; body: Record<string, unknown> }[];
  let transport: ReturnType<typeof mailchimpTransport>;
  const request: MailchimpRequest = async (input) => {
    expect(input.server).toBe('us7');
    expect(input.credential).toBe(credential);
    if (input.method === 'GET') {
      reads++;
      return member ? { status: 200, body: member } : { status: 404, body: {} };
    }
    const body = input.body as Record<string, unknown>;
    writes.push({ method: input.method, body });
    member = {
      id: mailchimpMemberHash(email),
      email_address: email,
      status: (body['status'] ?? member?.status ?? body['status_if_new']) as Member['status'],
      merge_fields: body['merge_fields'] as Record<string, unknown>,
      last_changed: clock.now().toISOString(),
      ...(body['timestamp_opt'] ? { timestamp_opt: String(body['timestamp_opt']) } : {}),
    };
    if (ambiguous) throw new Error('synthetic response lost');
    return { status: 200, body: member };
  };
  const configure = async (
    owner: 'mycel' | 'external' = 'mycel',
    operation: FormFeed['operation'] = 'subscribe'
  ) => {
    const c = await invoker.run(useCases.createConnection, admin, {
      provider: 'mailchimp',
      accountRef: 'synthetic-account',
      externalOwner: 'Example',
      maintainer: 'Operator',
      purpose: 'Newsletter',
      direction: 'outbound',
      dataAuthority: 'external',
      consentAuthority: owner,
      consentScopes: ['newsletter'],
      formIds: [FORM],
      destination: 'https://us7.api.mailchimp.com/3.0/lists/abc123',
      contractVersion: 'v1',
      adapterVersion: 'v1',
    });
    connectionId = c.id;
    const keyed = await invoker.run(useCases.replaceConnectionCredential, admin, {
      id: c.id,
      baseVersion: c.version,
      secret: credential,
    });
    const active = await invoker.run(useCases.resumeConnection, admin, {
      id: c.id,
      baseVersion: keyed.version,
    });
    feed = {
      id: 'news',
      formId: FORM,
      enabled: true,
      connectionId: c.id,
      connectionVersion: active.version,
      scope: 'newsletter',
      confirmationOwner: owner,
      operation,
      mapping: [{ fieldId: 'email', target: 'email' }],
    };
    const state = await uow.run(admin, (ctx) => ctx.formFeeds.get());
    await invoker.run(useCases.updateFormFeeds, admin, {
      baseVersion: state.version,
      value: { feeds: [feed] },
    });
  };
  const submit = async (confirmed = true) => {
    const sub = await invoker.run(useCases.submitForm, admin, {
      formId: FORM,
      locale: 'en',
      values: { email, consent: true },
    });
    if (sub.status !== 'accepted') throw new Error('fixture rejected');
    if (confirmed) {
      const token = await uow.run(admin, (ctx) =>
        signConfirmToken(
          ctx.signer,
          { tenantId: TENANT, submissionId: sub.submissionId, list: 'newsletter' },
          clock.now()
        )
      );
      await invoker.run(useCases.confirmSubscription, admin, { token });
    }
    for (const event of [...uow.store.outbox]) await formFeedSubscriber(uow).handle(event);
    const intent = await uow.run(
      admin,
      async (ctx) => (await ctx.connectionIntents.list(connectionId, 20))[0]
    );
    return { submissionId: sub.submissionId, intent };
  };
  const dispatch = (intent: ConnectionIntent) =>
    runConnectionIntent(
      {
        uow,
        clock,
        identity: { tenantAccess: async () => DEFAULT_ACCESS },
        transport,
        sources: { [FORM_FEED_SOURCE]: formFeedSource },
      },
      TENANT,
      intent.id
    );
  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({
      clock,
      dns: new FakeDns({ 'us7.api.mailchimp.com': ['8.8.8.8'] }),
      mailchimpDiscovery: {
        inspect: async () => ({
          server: 'us7',
          accountId: 'synthetic-account',
          accountName: 'Synthetic',
          audiences: [{ id: 'abc123', name: 'Synthetic', fields: [] }],
        }),
      },
    });
    invoker = new Invoker(buildRegistry(), uow);
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
    member = null;
    reads = 0;
    writes = [];
    ambiguous = false;
    transport = mailchimpTransport({
      uow,
      clock,
      identity: { tenantAccess: async () => DEFAULT_ACCESS },
      request,
    });
  });
  it('waits for Mycel confirmation, pins the audience and sends one idempotent effect', async () => {
    await configure();
    const pending = await submit(false);
    expect(pending.intent).toBeUndefined();
    expect(writes).toEqual([]);
    clock.advance(24 * 3600_000 + 1);
    const { intent } = await submit();
    await dispatch(intent!);
    await dispatch(intent!);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toMatchObject({ status_if_new: 'subscribed' });
    expect(writes[0]!.body).not.toHaveProperty('status');
    expect(member!.status).toBe('subscribed');
  });
  it.each(['unsubscribed', 'cleaned', 'pending', 'transactional'] as const)(
    'profile updates preserve %s',
    async (status) => {
      await configure();
      member = {
        id: mailchimpMemberHash(email),
        email_address: email,
        status,
        merge_fields: {},
        last_changed: clock.now().toISOString(),
      };
      const { intent } = await submit();
      await dispatch(intent!);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.method).toBe('PATCH');
      expect(writes[0]!.body).not.toHaveProperty('status');
      expect(member.status).toBe(status);
      if (status === 'unsubscribed' || status === 'cleaned')
        expect((await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.lists).toEqual(
          []
        );
    }
  );
  it('explicit resubscription requires a new submission and new confirmed evidence', async () => {
    await configure('mycel', 'resubscribe');
    member = {
      id: mailchimpMemberHash(email),
      email_address: email,
      status: 'unsubscribed',
      merge_fields: {},
      last_changed: clock.now().toISOString(),
    };
    clock.advance(2000);
    const { intent } = await submit();
    await dispatch(intent!);
    expect(writes[0]!.body['status']).toBe('subscribed');
  });
  it('provider-owned pending skips the Mycel confirmation link and promotes only fresh DOI evidence', async () => {
    await configure('external');
    const { intent, submissionId } = await submit(false);
    expect(intent).toBeDefined();
    const token = await uow.run(admin, (ctx) =>
      signConfirmToken(
        ctx.signer,
        { tenantId: TENANT, submissionId, list: 'newsletter' },
        clock.now()
      )
    );
    expect(await invoker.run(useCases.confirmSubscription, admin, { token })).toEqual({
      status: 'invalid',
    });
    await dispatch(intent!);
    expect(member!.status).toBe('pending');
    expect((await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.lists).toEqual([]);
    clock.advance(2000);
    member = {
      ...member!,
      status: 'subscribed',
      timestamp_opt: clock.now().toISOString(),
      last_changed: clock.now().toISOString(),
    };
    expect(await transport.sync(TENANT, intent!.id)).toBe(true);
    expect((await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.lists).toEqual([
      'newsletter',
    ]);
    expect(
      (await uow.run(admin, (ctx) => ctx.submissions.findById(submissionId)))!.confirmedAt
    ).toEqual(clock.now());
  });
  it('unavailable external confirmation consumes neither cooldown nor a local confirmation', async () => {
    await configure('external');
    uow.store.for(TENANT).connections.get(connectionId)!.state = 'paused';
    const input = { formId: FORM, locale: 'en', values: { email, consent: true } };
    expect(await invoker.run(useCases.submitForm, admin, input)).toMatchObject({
      status: 'rejected',
      reason: 'unavailable',
    });
    expect(uow.store.outbox).toEqual([]);
    uow.store.for(TENANT).connections.get(connectionId)!.state = 'active';
    expect(await invoker.run(useCases.submitForm, admin, input)).toMatchObject({
      status: 'accepted',
    });
    for (let i = 0; i < 4; i++)
      expect(await invoker.run(useCases.submitForm, admin, input)).toMatchObject({
        status: 'rejected',
        reason: 'recipient-limited',
      });
    expect(uow.store.outbox.filter((e) => e.type === 'newsletter.subscribed')).toHaveLength(1);
  });
  it('a profile operation and ordinary enrollment cannot manufacture provider resubscription evidence', async () => {
    await configure('external', 'profile');
    const first = await submit(false);
    await dispatch(first.intent!);
    expect(writes).toEqual([]);
    clock.advance(2000);
    member = {
      id: mailchimpMemberHash(email),
      email_address: email,
      status: 'subscribed',
      merge_fields: {},
      last_changed: clock.now().toISOString(),
      timestamp_opt: clock.now().toISOString(),
    };
    await transport.sync(TENANT, first.intent!.id);
    expect((await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.lists).toEqual([]);
  });
  it('refuses two confirmation owners for one scope, including different forms', async () => {
    await configure('external');
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(OTHER)));
    const state = await uow.run(admin, (ctx) => ctx.formFeeds.get());
    await expect(
      invoker.run(useCases.updateFormFeeds, admin, {
        baseVersion: state.version,
        value: {
          feeds: [feed, { ...feed, id: 'other', formId: OTHER, confirmationOwner: 'mycel' }],
        },
      })
    ).rejects.toThrow('one confirmation owner is required per scope');
  });
  it.each(['withdrawal', 'disconnect'] as const)(
    'rechecks %s after the provider preflight and before its write',
    async (change) => {
      await configure();
      const { intent } = await submit();
      transport = mailchimpTransport({
        uow,
        clock,
        identity: { tenantAccess: async () => DEFAULT_ACCESS },
        request: async (input) => {
          const result = await request(input);
          if (input.method === 'GET') {
            if (change === 'disconnect')
              uow.store.for(TENANT).connections.get(connectionId)!.state = 'disconnected';
            else uow.store.for(TENANT).projections.get(email)!.lists = [];
          }
          return result;
        },
      });
      await dispatch(intent!);
      expect(writes).toEqual([]);
      expect((await uow.run(admin, (ctx) => ctx.connectionIntents.get(intent!.id)))!.state).toBe(
        'pending'
      );
    }
  );
  it('historic subscribed state is never proof of this provider-owned confirmation', async () => {
    await configure('external');
    member = {
      id: mailchimpMemberHash(email),
      email_address: email,
      status: 'subscribed',
      merge_fields: {},
      last_changed: clock.now().toISOString(),
      timestamp_opt: clock.now().toISOString(),
    };
    clock.advance(2000);
    const { intent, submissionId } = await submit(false);
    await dispatch(intent!);
    await transport.sync(TENANT, intent!.id);
    expect((await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.lists).toEqual([]);
    expect(
      (await uow.run(admin, (ctx) => ctx.submissions.findById(submissionId)))!.confirmedAt
    ).toBeNull();
  });
  it('timeout is unknown and targeted reconciliation never repeats the write', async () => {
    await configure();
    const { intent } = await submit();
    ambiguous = true;
    await dispatch(intent!);
    expect((await uow.run(admin, (ctx) => ctx.connectionIntents.get(intent!.id)))!.state).toBe(
      'unknown'
    );
    clock.advance(61_000);
    await dispatch(intent!);
    expect(writes).toHaveLength(1);
    expect(reads).toBe(2);
    expect((await uow.run(admin, (ctx) => ctx.connectionIntents.get(intent!.id)))!.state).toBe(
      'succeeded'
    );
  });
  it('disconnect and A/B isolation prevent provider work and receipt disclosure', async () => {
    await configure();
    const { intent } = await submit();
    await dispatch(intent!);
    expect(
      await uow.run(systemPrincipal(OTHER, 'test'), (ctx) => ctx.mailchimpReceipts.get(intent!.id))
    ).toBeNull();
    expect(await transport.sync(OTHER, intent!.id)).toBe(false);
    const c = await invoker.run(useCases.getConnection, admin, { id: connectionId });
    await invoker.run(useCases.disconnectConnection, admin, { id: c.id, baseVersion: c.version });
    const before = reads;
    expect(await transport.sync(TENANT, intent!.id)).toBe(false);
    expect(reads).toBe(before);
    expect(
      JSON.stringify(await invoker.run(useCases.getConnection, admin, { id: c.id }))
    ).not.toContain(credential);
  });
  it.each(['email', 'erasure'] as const)(
    'rechecks %s immediately before dispatch and comparison',
    async (change) => {
      await configure();
      const { intent } = await submit();
      if (change === 'email')
        await invoker.run(useCases.changeSupporterEmail, admin, {
          supporterId: intent!.supporterId!,
          newEmail: 'changed@example.org',
          reason: 'Synthetic verified request',
        });
      else await uow.run(admin, (ctx) => ctx.erasures.register(intent!.supporterId!, email));
      await dispatch(intent!);
      expect(writes).toEqual([]);
      expect(await transport.sync(TENANT, intent!.id)).toBe(false);
    }
  );
  it.each([401, 429] as const)(
    'a proven no-effect %s response can retry without resetting its baseline',
    async (status) => {
      await configure();
      const { intent } = await submit();
      let refused = false;
      transport = mailchimpTransport({
        uow,
        clock,
        identity: { tenantAccess: async () => DEFAULT_ACCESS },
        request: async (input) => {
          if (input.method !== 'GET' && !refused) {
            refused = true;
            return { status, body: { detail: credential } };
          }
          return request(input);
        },
      });
      await dispatch(intent!);
      expect(writes).toEqual([]);
      expect(
        (await uow.run(admin, (ctx) => ctx.mailchimpReceipts.get(intent!.id)))!.retryable
      ).toBe(true);
      clock.advance(61_000);
      await dispatch(intent!);
      expect(writes).toHaveLength(1);
      expect(
        (await uow.run(admin, (ctx) => ctx.mailchimpReceipts.get(intent!.id)))!.baselineStatus
      ).toBe('absent');
    }
  );
  it('credential rotation cannot silently move the connection to another provider account', async () => {
    await configure();
    const before = await invoker.run(useCases.getConnection, admin, { id: connectionId });
    uow.mailchimpDiscovery.inspect = async () => ({
      server: 'us7',
      accountId: 'other-account',
      accountName: 'Other',
      audiences: [{ id: 'abc123', name: 'Same id', fields: [] }],
    });
    await expect(
      invoker.run(useCases.replaceConnectionCredential, admin, {
        id: connectionId,
        baseVersion: before.version,
        secret: 'synthetic-foreign-key',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await invoker.run(useCases.getConnection, admin, { id: connectionId })).version).toBe(
      before.version
    );
    await expect(
      invoker.run(useCases.updateConnection, admin, {
        id: connectionId,
        baseVersion: before.version,
        changes: { accountRef: 'other-account' },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it.each(['unsubscribed', 'cleaned', 'archived', 'absent'] as const)(
    'a delayed old-address %s observation must not suppress the changed address',
    async (status) => {
      await configure();
      const { intent } = await submit();
      await dispatch(intent!);
      clock.advance(2000);
      member = { ...member!, status: 'unsubscribed', last_changed: clock.now().toISOString() };
      if (status === 'absent') member = null;
      else member = { ...member!, status };
      const receipt = await uow.run(admin, (ctx) => ctx.mailchimpReceipts.get(intent!.id));
      const delayed = mailchimpTransport({
        uow,
        clock,
        identity: { tenantAccess: async () => DEFAULT_ACCESS },
        request: async (input) => {
          const result = await request(input);
          await invoker.run(useCases.changeSupporterEmail, admin, {
            supporterId: intent!.supporterId!,
            newEmail: 'changed@example.org',
            reason: 'Synthetic verified request during provider read',
          });
          expect(
            (await uow.run(admin, (ctx) => ctx.supporters.getProjectionById(intent!.supporterId!)))!
              .lists
          ).toEqual(['newsletter']);
          return result;
        },
      });
      await delayed.sync(TENANT, intent!.id);
      const projection = await uow.run(admin, (ctx) =>
        ctx.supporters.getProjectionById(intent!.supporterId!)
      );
      expect(projection!.email).toBe('changed@example.org');
      expect(projection!.lists).toEqual(['newsletter']);
      expect(await uow.run(admin, (ctx) => ctx.mailchimpReceipts.get(intent!.id))).toEqual(receipt);
      expect(writes).toHaveLength(1);
    }
  );
  it('records provider suppression without local marketing consent', async () => {
    await configure('external');
    const { intent, submissionId } = await submit(false);
    await dispatch(intent!);
    expect((await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.lists).toEqual([]);
    clock.advance(2000);
    member = { ...member!, status: 'unsubscribed', last_changed: clock.now().toISOString() };
    await transport.sync(TENANT, intent!.id);
    expect(await uow.run(admin, (ctx) => ctx.mailchimpReceipts.get(intent!.id))).toMatchObject({
      status: 'unsubscribed',
      observedAt: clock.now(),
      confirmedAt: null,
    });
    expect(
      (await uow.run(admin, (ctx) => ctx.submissions.findById(submissionId)))!.confirmedAt
    ).toBeNull();
    expect(writes).toHaveLength(1);
  });
  it('incoming changes queue only an authenticated read and periodic comparison suppresses locally', async () => {
    await configure();
    const { intent } = await submit();
    await dispatch(intent!);
    const { token } = await invoker.run(useCases.getMailchimpCallback, admin, { id: connectionId });
    await queueMailchimpCallback(
      { signer: uow.signer, uow, access: async () => DEFAULT_ACCESS },
      token,
      mailchimpMemberHash(email)
    );
    await queueMailchimpCallback(
      { signer: uow.signer, uow, access: async () => DEFAULT_ACCESS },
      token,
      mailchimpMemberHash(email)
    );
    expect(uow.store.jobs.filter((j) => j.key.startsWith('mailchimp.callback:'))).toHaveLength(2);
    expect(
      uow.store.jobs.filter((j) => j.key === `connections.mailchimp.sync:${intent!.id}`)
    ).toHaveLength(1);
    clock.advance(2000);
    const state = await uow.run(admin, (ctx) => ctx.formFeeds.get());
    await invoker.run(useCases.updateFormFeeds, admin, {
      baseVersion: state.version,
      value: { feeds: [{ ...feed, enabled: false }] },
    });
    expect(await uow.run(admin, (ctx) => formFeedSource.prepare(ctx, intent!))).toMatchObject({
      ready: false,
    });
    member = { ...member!, status: 'unsubscribed', last_changed: clock.now().toISOString() };
    await transport.sync(TENANT, intent!.id);
    expect((await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.lists).toEqual([]);
  });
  it('a provider withdrawal still reaches local consent after the submission passed its retention term', async () => {
    await configure();
    const { intent, submissionId } = await submit();
    await dispatch(intent!);
    const lists = async () =>
      (await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.lists;
    expect((await uow.run(admin, (ctx) => ctx.connectionIntents.get(intent!.id)))!.state).toBe(
      'succeeded'
    );
    expect(await lists()).toEqual(['newsletter']);
    // Twenty-five months on, retention has deleted the submission (`applyRetention`).
    clock.advance(25 * 31 * 24 * 3600_000);
    uow.store.for(TENANT).submissions.delete(submissionId);
    // Still subscribed at the provider: the hourly comparison goes on and changes nothing.
    expect(await transport.sync(TENANT, intent!.id)).toBe(true);
    expect(await lists()).toEqual(['newsletter']);
    member = { ...member!, status: 'unsubscribed', last_changed: clock.now().toISOString() };
    expect(await transport.sync(TENANT, intent!.id)).toBe(true);
    expect(await lists()).toEqual([]);
    expect((await uow.run(admin, (ctx) => ctx.mailchimpReceipts.get(intent!.id)))!.status).toBe(
      'unsubscribed'
    );
    // A later subscribed status at the provider grants nothing without the submission.
    member = { ...member!, status: 'subscribed', last_changed: clock.now().toISOString() };
    expect(await transport.sync(TENANT, intent!.id)).toBe(true);
    expect(await lists()).toEqual([]);
  });
  describe('a readmitted lifecycle whose submission passed its retention term', () => {
    // ADR 032 rule 3: erased, signed up again through the fed form, then the term ran out.
    const readmit = async () => {
      const first = await submit();
      await dispatch(first.intent!);
      await uow.run(admin, async (ctx) => {
        await ctx.erasures.register(first.intent!.supporterId!, email);
        await ctx.erasures.apply();
      });
      // Past the resubmission cooldown, and strictly later than the erasure.
      clock.advance(86_400_001);
      member = null;
      const again = await invoker.run(useCases.submitForm, admin, {
        formId: FORM,
        locale: 'en',
        values: { email, consent: true },
      });
      if (again.status !== 'accepted') throw new Error('fixture rejected');
      const token = await uow.run(admin, (ctx) =>
        signConfirmToken(
          ctx.signer,
          { tenantId: TENANT, submissionId: again.submissionId, list: 'newsletter' },
          clock.now()
        )
      );
      await invoker.run(useCases.confirmSubscription, admin, { token });
      for (const event of [...uow.store.outbox]) await formFeedSubscriber(uow).handle(event);
      const supporter = (await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!;
      expect(supporter.id).not.toBe(first.intent!.supporterId);
      const intent = (
        await uow.run(admin, (ctx) => ctx.connectionIntents.list(connectionId, 20))
      ).find((i) => i.supporterId === supporter.id)!;
      await dispatch(intent);
      expect(supporter.lists).toEqual(['newsletter']);
      clock.advance(25 * 31 * 24 * 3600_000);
      uow.store.for(TENANT).submissions.delete(again.submissionId);
      return { intent, supporter };
    };
    const lists = async () =>
      (await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))?.lists;
    const withdrawal = (lifecycleId: string, intentId: string, at: string): SupporterEvent => ({
      schema: 'wings.supporter-event.v1',
      id: `forged:${at}`,
      type: 'newsletter.unsubscribed',
      email,
      occurred_at: clock.now().toISOString(),
      lifecycle_id: lifecycleId,
      source: 'mailchimp',
      source_site: 'urn:mycel:connection:' + connectionId,
      source_ref: intentId,
      props: { list: 'newsletter' },
    });

    it('applies a provider withdrawal from the receipt of the live lifecycle', async () => {
      await configure();
      const { intent } = await readmit();
      member = { ...member!, status: 'unsubscribed', last_changed: clock.now().toISOString() };
      expect(await transport.sync(TENANT, intent.id)).toBe(true);
      expect(await lists()).toEqual([]);
      // The receipt removes permission only: a later subscribed status grants nothing.
      member = { ...member!, status: 'subscribed', last_changed: clock.now().toISOString() };
      expect(await transport.sync(TENANT, intent.id)).toBe(true);
      expect(await lists()).toEqual([]);
    });

    it('accepts the receipt for a withdrawal only, and only for its own lifecycle and address', async () => {
      await configure();
      const { intent, supporter } = await readmit();
      const proof = { receiptIntentId: intent.id, memberHash: mailchimpMemberHash };
      const run = (event: SupporterEvent, evidence?: WithdrawalEvidence) =>
        uow.run(admin, (ctx) => ingest(ctx, event, evidence));
      const event = withdrawal(supporter.id, intent.id, 'a');
      // No evidence, no such receipt, a hash of another address, a grant: all refused.
      expect(await run(event)).toBe(false);
      expect(await run(event, { ...proof, receiptIntentId: randomUUID() })).toBe(false);
      expect(await run(event, { ...proof, memberHash: () => 'other' })).toBe(false);
      expect(await run({ ...event, type: 'newsletter.subscribed' }, proof)).toBe(false);
      expect(await lists()).toEqual(['newsletter']);
      expect(await run(event, proof)).toBe(true);
      expect(await lists()).toEqual([]);
    });

    describe('before the readmitted lifecycle has a projection', () => {
      // Erasure registered but not applied, then the new signup admitted and not yet ingested:
      // the first lifecycle's receipt and projection still exist, with the same member hash.
      const admitted = async () => {
        const first = await submit();
        await dispatch(first.intent!);
        await uow.run(admin, (ctx) => ctx.erasures.register(first.intent!.supporterId!, email));
        clock.advance(86_400_001);
        const again = await invoker.run(useCases.submitForm, admin, {
          formId: FORM,
          locale: 'en',
          values: { email, consent: true },
        });
        if (again.status !== 'accepted') throw new Error('fixture rejected');
        const [old, receipt, lifecycleId] = await uow.run(admin, async (ctx) => [
          await ctx.supporters.getProjectionById(first.intent!.supporterId!),
          (await ctx.mailchimpReceipts.get(first.intent!.id))!,
          (await ctx.submissions.findById(again.submissionId))!.evaluation!.supporterLifecycleId!,
        ]);
        expect(old!.email).toBe(email);
        expect(receipt.memberHash).toBe(mailchimpMemberHash(email));
        expect(lifecycleId).not.toBe(receipt.supporterId);
        expect(await uow.run(admin, (ctx) => ctx.erasures.allows(email, lifecycleId))).toBe(true);
        expect(
          await uow.run(admin, (ctx) => ctx.supporters.getProjectionById(lifecycleId))
        ).toBeNull();
        return { receipt, lifecycleId };
      };
      const refused = async (lifecycleId: string, receiptIntentId: string) => {
        const proof = { receiptIntentId, memberHash: mailchimpMemberHash };
        expect(
          await uow.run(admin, (ctx) =>
            ingest(ctx, withdrawal(lifecycleId, receiptIntentId, 'c'), proof)
          )
        ).toBe(false);
        // Nothing was opened or retired on the strength of the receipt.
        expect(
          await uow.run(admin, (ctx) => ctx.supporters.getProjectionById(lifecycleId))
        ).toBeNull();
        expect(await lists()).toEqual(['newsletter']);
      };

      it('refuses an existing receipt of another lifecycle with the same member hash', async () => {
        await configure();
        const { receipt, lifecycleId } = await admitted();
        await refused(lifecycleId, receipt.intentId);
      });

      it('refuses a receipt whose lifecycle has no projection holding the address', async () => {
        await configure();
        const { receipt, lifecycleId } = await admitted();
        // A receipt row for the admitted lifecycle itself; only the projection is missing.
        const intentId = randomUUID();
        expect(
          await uow.run(admin, (ctx) =>
            ctx.mailchimpReceipts.insert({ ...receipt, intentId, supporterId: lifecycleId })
          )
        ).toBe(true);
        await refused(lifecycleId, intentId);
      });
    });

    it('refuses the receipt once its lifecycle is erased too', async () => {
      await configure();
      const { intent, supporter } = await readmit();
      await uow.run(admin, (ctx) => ctx.erasures.register(supporter.id, email));
      member = { ...member!, status: 'unsubscribed', last_changed: clock.now().toISOString() };
      expect(await transport.sync(TENANT, intent.id)).toBe(false);
      const proof = { receiptIntentId: intent.id, memberHash: mailchimpMemberHash };
      expect(
        await uow.run(admin, (ctx) => ingest(ctx, withdrawal(supporter.id, intent.id, 'b'), proof))
      ).toBe(false);
    });
  });
  it.each(['email', 'erasure'] as const)(
    'without the submission, a withdrawal is not applied after %s moved the address away',
    async (change) => {
      await configure();
      const { intent, submissionId } = await submit();
      await dispatch(intent!);
      uow.store.for(TENANT).submissions.delete(submissionId);
      if (change === 'email')
        await invoker.run(useCases.changeSupporterEmail, admin, {
          supporterId: intent!.supporterId!,
          newEmail: 'changed@example.org',
          reason: 'Synthetic verified request',
        });
      else await uow.run(admin, (ctx) => ctx.erasures.register(intent!.supporterId!, email));
      member = { ...member!, status: 'unsubscribed', last_changed: clock.now().toISOString() };
      expect(await transport.sync(TENANT, intent!.id)).toBe(false);
      if (change === 'email')
        expect(
          (await uow.run(admin, (ctx) => ctx.supporters.getProjection('changed@example.org')))!
            .lists
        ).toEqual(['newsletter']);
    }
  );

  // ADR 033 rule 7: on a campaign's form the signature and the consent are two confirmations with
  // their own facts. The provider owns consent here, so it confirms on its own clock; Mycel's link
  // confirms the signature only. Neither order may lose the other, and the signature time never
  // travels to the provider as consent time.
  describe('a campaign form with an external consent owner', () => {
    let seen: Set<string>;
    const campaignForm = async ({ consentRequired = true } = {}) => {
      await configure('external');
      if (!consentRequired) {
        const form = probeForm(FORM);
        await uow.run(admin, (ctx) =>
          ctx.forms.insert({
            ...form,
            fields: form.fields.map((f) => (f.type === 'consent' ? { ...f, required: false } : f)),
          })
        );
      }
      const { item } = await invoker.run(useCases.createItem, admin, {
        slug: 'join',
        document: {
          type: 'page',
          defaultLocale: 'en',
          locales: ['en'],
          title: { en: 'Join' },
          blocks: [],
        } as never,
      });
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: item.latestRevisionId,
        locale: 'en',
      });
      const created = await invoker.run(useCases.createCampaign, admin, {
        kind: 'signup',
        landingItemId: item.id,
        formId: FORM,
      });
      const campaign = await invoker.run(useCases.openCampaign, admin, {
        campaignId: created.id,
        baseUpdatedAt: created.updatedAt,
      });
      seen = new Set();
      return campaign.id;
    };
    /** Deliver new outbox events to feed and ingest, as the worker would after commit. */
    const drain = async () => {
      const fresh = uow.store.outbox.filter((e) => !seen.has(e.id));
      for (const e of fresh) {
        seen.add(e.id);
        for (const sub of [formFeedSubscriber(uow), supporterIngestSubscriber(uow)])
          if (sub.types.includes(e.type)) await sub.handle(e);
      }
      return fresh.map((e) => e.type);
    };
    const sign = async (consent: boolean) => {
      const sub = await invoker.run(useCases.submitForm, admin, {
        formId: FORM,
        locale: 'en',
        values: { email, consent },
      });
      if (sub.status !== 'accepted') throw new Error('fixture rejected');
      await drain();
      return sub.submissionId;
    };
    const token = (submissionId: string) =>
      uow.run(admin, (ctx) =>
        signConfirmToken(
          ctx.signer,
          { tenantId: TENANT, submissionId, list: 'newsletter' },
          clock.now()
        )
      );
    const mycelLink = async (submissionId: string) =>
      invoker.run(useCases.confirmSubscription, admin, { token: await token(submissionId) });
    const preview = async (submissionId: string) =>
      (await invoker.run(useCases.previewConfirmation, admin, { token: await token(submissionId) }))
        .status;
    const providerConfirms = async (intent: ConnectionIntent) => {
      clock.advance(2000);
      member = {
        ...member!,
        status: 'subscribed',
        timestamp_opt: clock.now().toISOString(),
        last_changed: clock.now().toISOString(),
      };
      expect(await transport.sync(TENANT, intent.id)).toBe(true);
      return clock.now();
    };
    const intentOf = async () =>
      (await uow.run(
        admin,
        async (ctx) => (await ctx.connectionIntents.list(connectionId, 20))[0]
      ))!;
    const submission = (id: string) => uow.run(admin, (ctx) => ctx.submissions.findById(id));
    const participants = async (campaignId: string) =>
      (await invoker.run(useCases.getCampaign, admin, { campaignId })).participants;
    const lists = async () =>
      (await uow.run(admin, (ctx) => ctx.supporters.getProjection(email)))!.lists;

    it('the provider confirms consent first, and the signature still counts', async () => {
      const campaignId = await campaignForm();
      const submissionId = await sign(true);
      const intent = await intentOf();
      await dispatch(intent);
      expect(member!.status).toBe('pending');
      const optAt = await providerConfirms(intent);
      expect(await drain()).toEqual(['consent.given']);
      expect(await lists()).toEqual(['newsletter']);
      expect(await participants(campaignId)).toBe(0);

      // The page behind Mycel's link still offers the signature.
      expect(await preview(submissionId)).toBe('pending');
      clock.advance(1000);
      expect(await mycelLink(submissionId)).toEqual({ status: 'confirmed', locale: 'en' });
      expect(await drain()).toEqual(['form.submitted']);
      expect(await participants(campaignId)).toBe(1);
      const row = (await submission(submissionId))!;
      expect(row.confirmedAt).toEqual(optAt);
      expect(row.participationConfirmedAt).toEqual(clock.now());
      expect(await preview(submissionId)).toBe('already_confirmed');
      expect(await mycelLink(submissionId)).toMatchObject({ status: 'already_confirmed' });
      expect(await drain()).toEqual([]);
    });

    it("Mycel's link confirms the signature first, and the provider's consent still arrives", async () => {
      const campaignId = await campaignForm();
      const submissionId = await sign(true);
      expect(await mycelLink(submissionId)).toEqual({ status: 'confirmed', locale: 'en' });
      // The signature only: no consent event, and consent stays unconfirmed for every reader.
      expect(await drain()).toEqual(['form.submitted']);
      expect(await participants(campaignId)).toBe(1);
      expect((await submission(submissionId))!.confirmedAt).toBeNull();

      const intent = await intentOf();
      await dispatch(intent);
      // The signature time is not consent time: no opt-in timestamp goes to the provider.
      expect(writes).toHaveLength(1);
      expect(writes[0]!.body).not.toHaveProperty('timestamp_opt');
      expect(member!.status).toBe('pending');
      expect(await lists()).toEqual([]);

      const optAt = await providerConfirms(intent);
      expect(await drain()).toEqual(['consent.given']);
      expect(await lists()).toEqual(['newsletter']);
      expect((await submission(submissionId))!.confirmedAt).toEqual(optAt);
      expect(await participants(campaignId)).toBe(1);
    });

    it('a signature without the box ticked confirms no consent', async () => {
      const campaignId = await campaignForm({ consentRequired: false });
      const submissionId = await sign(false);
      expect(await intentOf()).toBeUndefined();
      expect(await mycelLink(submissionId)).toEqual({ status: 'confirmed', locale: 'en' });
      expect(await drain()).toEqual(['form.submitted']);
      expect(await participants(campaignId)).toBe(1);
      const row = (await submission(submissionId))!;
      expect(row.confirmedAt).toBeNull();
      expect(row.participationConfirmedAt).toEqual(clock.now());
      expect(await lists()).toEqual([]);
      expect(writes).toEqual([]);
    });
  });
});

describe('Mailchimp account discovery', () => {
  it('validates documented member fixtures without promoting unmodelled provider fields', () => {
    expect(MemberSchema.parse(fixture('member'))).toMatchObject({ status: 'subscribed' });
  });
  it('reads account, audiences and mapping schema without member addresses', async () => {
    const paths: string[] = [];
    const account = await inspectMailchimp(credential, async (input) => {
      paths.push(input.path);
      return {
        status: 200,
        body: fixture(
          input.path === '/'
            ? 'account'
            : input.path.startsWith('/lists?')
              ? 'lists'
              : 'merge-fields'
        ),
      };
    });
    expect(account.audiences[0]!.fields[0]!.tag).toBe('FNAME');
    expect(paths).toHaveLength(3);
    expect(paths.join()).not.toContain('members');
    expect(JSON.stringify(account)).not.toContain(credential);
  });
  it.each([401, 429, 503])(
    'redacts credential expiry/rate limit/provider failure %s',
    async (status) => {
      await expect(
        inspectMailchimp(credential, async () => ({
          status,
          body: { detail: credential, email: 'private@example.org' },
        }))
      ).rejects.toThrow('Mailchimp account or audience is unavailable');
    }
  );
  it.each([
    'https://us7.api.mailchimp.com.evil.test/3.0/lists/a',
    'https://127.0.0.1/3.0/lists/a',
    'https://us7.api.mailchimp.com/3.0/lists/a?x=1',
    'https://key@us7.api.mailchimp.com/3.0/lists/a',
  ])('refuses provider URL injection %s', (url) => {
    expect(mailchimpTarget(url)).toBeNull();
  });
});
