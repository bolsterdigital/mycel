// Feed boundary tests exercise real submission, confirmation, outbox and connection dispatch.
// Rejected: testing mapping alone while skipping current consent and durable intent ownership.
import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { systemPrincipal } from '../principal.js';
import { DEFAULT_ACCESS } from '../entitlements/model.js';
import { FakeClock, FakeDns, MemoryUnitOfWork, probeForm, TENANT } from '../testing/index.js';
import { signConfirmToken } from '../mailing/confirmation.js';
import { formFeedSource, formFeedSubscriber } from './feed/delivery.js';
import { FORM_FEED_SOURCE, type FormFeed } from './feed/model.js';
import { runConnectionIntent } from '../connections/dispatch.js';
import { ingest } from '../supporters/service.js';

const FORM = '01900000-0000-7000-8000-00000000f000';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const admin = systemPrincipal(TENANT, 'feeds-test');
describe('form feeds', () => {
  let uow: MemoryUnitOfWork, invoker: Invoker, clock: FakeClock, feed: FormFeed;
  const configure = async (next = feed) => {
    const state = await uow.run(admin, (ctx) => ctx.formFeeds.get());
    return invoker.run(useCases.updateFormFeeds, admin, {
      baseVersion: state.version,
      value: { feeds: [next] },
    });
  };
  const submit = async () => {
    const result = await invoker.run(useCases.submitForm, admin, {
      formId: FORM,
      locale: 'en',
      values: { email: 'visitor@example.org', consent: true, gate: false, private: 'forged' },
    });
    if (result.status !== 'accepted') throw new Error(JSON.stringify(result));
    return result.submissionId;
  };
  const confirm = async (id: string) => {
    const token = await uow.run(admin, (ctx) =>
      signConfirmToken(
        ctx.signer,
        {
          tenantId: TENANT,
          submissionId: id,
          list: 'newsletter',
        },
        clock.now()
      )
    );
    await invoker.run(useCases.confirmSubscription, admin, { token });
    const event = uow.store.outbox.find(
      (e) => e.type === 'consent.given' && e.props['submissionId'] === id
    )!;
    await formFeedSubscriber(uow).handle(event);
    return event;
  };
  const intents = () => uow.run(admin, (ctx) => ctx.connectionIntents.list(feed.connectionId!, 20));
  const dispatch = async (id: string, outcome: 'succeeded' | 'unknown' = 'succeeded') => {
    const sent: unknown[] = [];
    await runConnectionIntent(
      {
        uow,
        clock,
        identity: { tenantAccess: async () => DEFAULT_ACCESS },
        sources: { [FORM_FEED_SOURCE]: formFeedSource },
        transport: {
          async dispatch(input) {
            sent.push(input.payload);
            return outcome;
          },
        },
      },
      TENANT,
      id
    );
    return sent;
  };
  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock, dns: new FakeDns({ 'hooks.example.org': ['8.8.8.8'] }) });
    invoker = new Invoker(buildRegistry(), uow);
    const form = probeForm(FORM);
    form.fields.push(
      { name: 'gate', type: 'checkbox', required: false, label: { en: 'Gate' } },
      {
        name: 'private',
        type: 'text',
        required: false,
        label: { en: 'Private' },
        activeWhen: { op: 'equals', fieldId: 'gate', value: true },
      }
    );
    await uow.run(admin, (ctx) => ctx.forms.insert(form));
    const c = await invoker.run(useCases.createConnection, admin, {
      provider: 'webhook',
      accountRef: null,
      externalOwner: 'Example',
      maintainer: 'Operator',
      purpose: 'Newsletter',
      direction: 'outbound',
      dataAuthority: 'mycel',
      consentAuthority: 'mycel',
      consentScopes: ['newsletter'],
      formIds: [FORM],
      destination: 'https://hooks.example.org/feed',
      contractVersion: 'v1',
      adapterVersion: 'v1',
    });
    const credential = await invoker.run(useCases.replaceConnectionCredential, admin, {
      id: c.id,
      baseVersion: c.version,
      secret: 'synthetic-secret',
    });
    const active = await invoker.run(useCases.resumeConnection, admin, {
      id: c.id,
      baseVersion: credential.version,
    });
    feed = {
      id: 'news',
      formId: FORM,
      enabled: true,
      connectionId: c.id,
      connectionVersion: active.version,
      scope: 'newsletter',
      confirmationOwner: 'mycel',
      mapping: [
        { fieldId: 'email', target: 'email' },
        { fieldId: 'private', target: 'private' },
      ],
    };
    await configure();
  });
  it('pins a mapping, waits for confirmation, deduplicates and omits inactive values', async () => {
    const id = await submit();
    expect(await intents()).toEqual([]);
    await configure({ ...feed, mapping: [{ fieldId: 'email', target: 'renamed' }] });
    const event = await confirm(id);
    await formFeedSubscriber(uow).handle(event);
    const rows = await intents();
    expect(rows).toHaveLength(1);
    const sent = await dispatch(rows[0]!.id);
    expect(sent).toMatchObject([
      {
        category: FORM_FEED_SOURCE,
        data: {
          fields: { email: 'visitor@example.org' },
          consent: { scope: 'newsletter', owner: 'mycel' },
        },
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain('private');
    expect(JSON.stringify(sent)).not.toContain('renamed');
    expect(await dispatch(rows[0]!.id)).toEqual([]);
  });
  it('rehearses the same condition without creating consent or work; unconnected feeds stay disabled', async () => {
    await configure({ ...feed, when: { op: 'equals', fieldId: 'gate', value: true } });
    const tested = await invoker.run(useCases.testFormFeed, admin, {
      feedId: 'news',
      values: { email: 'test@example.org', consent: true, gate: false },
    });
    expect(tested).toMatchObject({ matches: false, requiresConfirmation: true });
    expect(await intents()).toEqual([]);
    expect(uow.store.outbox).toHaveLength(0);
    await configure({ ...feed, enabled: false, connectionId: null, connectionVersion: null });
    expect((await invoker.run(useCases.getFormFeeds, admin, {})).availability[0]!.failure).toBe(
      'source'
    );
    await expect(
      configure({ ...feed, connectionId: null, connectionVersion: null })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(configure({ ...feed, scope: 'another-list' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
  it.each(['disabled', 'version', 'erased', 'withdrawn', 'missing', 'revoked'] as const)(
    'blocks %s before dispatch',
    async (reason) => {
      const id = await submit();
      await confirm(id);
      const row = (await intents())[0]!;
      if (reason === 'revoked') {
        uow.store.for(TENANT).submissions.get(id)!.evaluation!.feedActions![0]!.actor = {
          kind: 'operator',
          id: 'revoked-operator',
        };
      }
      if (reason === 'disabled') await configure({ ...feed, enabled: false });
      if (reason === 'version')
        await invoker.run(useCases.updateConnection, admin, {
          id: feed.connectionId!,
          baseVersion: feed.connectionVersion!,
          changes: { purpose: 'Changed' },
        });
      if (reason === 'missing') uow.store.for(TENANT).submissions.delete(id);
      if (reason === 'erased') {
        await uow.run(admin, (ctx) =>
          ctx.erasures.register(row.supporterId!, 'visitor@example.org')
        );
      }
      if (reason === 'withdrawn') {
        clock.advance(1000);
        await uow.run(admin, async (ctx) => {
          const history = await ctx.supporters.eventsFor(row.supporterId!);
          await ingest(ctx, {
            ...history[0]!,
            id: 'withdraw-feed',
            type: 'consent.withdrawn',
            occurred_at: clock.now().toISOString(),
            props: { list: 'newsletter' },
          });
          clock.advance(1000);
          await ingest(ctx, {
            ...history[0]!,
            id: 'later-consent',
            type: 'consent.given',
            occurred_at: clock.now().toISOString(),
            props: { list: 'newsletter' },
          });
        });
      }
      expect(await dispatch(row.id)).toEqual([]);
      expect((await intents())[0]!.state).toBe('blocked');
    }
  );
  it('retains a paused confirmation for guarded delivery and never blindly repeats unknown work', async () => {
    const id = await submit();
    // Pause without changing the accepted connection contract to model a kill switch during claim.
    uow.store.for(TENANT).connections.get(feed.connectionId!)!.state = 'paused';
    await confirm(id);
    const row = (await intents())[0]!;
    expect(row.state).toBe('pending');
    expect(await dispatch(row.id)).toEqual([]);
    uow.store.for(TENANT).connections.get(feed.connectionId!)!.state = 'active';
    clock.advance(61000);
    expect(await dispatch(row.id, 'unknown')).toHaveLength(1);
    expect(await dispatch(row.id)).toEqual([]);
    await expect(
      invoker.run(useCases.replayConnectionIntent, admin, { id: row.id })
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('isolates settings and refuses stale writes and an unprivileged activation', async () => {
    expect(
      (await invoker.run(useCases.getFormFeeds, systemPrincipal(OTHER, 'test'), {})).state.version
    ).toBe(0);
    await expect(
      invoker.run(useCases.updateFormFeeds, systemPrincipal(OTHER, 'test'), {
        baseVersion: 0,
        value: { feeds: [feed] },
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      invoker.run(useCases.updateFormFeeds, admin, { baseVersion: 0, value: { feeds: [feed] } })
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      invoker.run(
        useCases.updateFormFeeds,
        { ...admin, capabilities: ['connections:configure'] },
        { baseVersion: 1, value: { feeds: [feed] } }
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it.each(['operator', 'api-key'] as const)(
    'refuses %s publication authority revoked after payload preparation',
    async (kind) => {
      const operatorId = '01900000-0000-7000-8000-00000000abcd';
      await uow.run(admin, (ctx) => ctx.operators.forInvite('review@example.org', operatorId));
      uow.store.for(TENANT).members.set(operatorId, {
        capabilities: ['connections:configure', 'content:publish'],
        createdAt: clock.now(),
      });
      if (kind === 'api-key') {
        await uow.run(admin, (ctx) =>
          ctx.apiKeys.insert({
            id: operatorId,
            name: 'Feed key',
            keyHash: 'hash',
            prefix: 'test',
            capabilities: ['connections:configure', 'content:publish'],
            createdAt: clock.now(),
            createdBy: admin.actor,
          })
        );
      }
      await uow.run(admin, async (ctx) => {
        const state = await ctx.formFeeds.get();
        await ctx.formFeeds.save(state.version, state.value, { kind, id: operatorId });
      });
      const submissionId = await submit();
      await confirm(submissionId);
      const row = (await intents())[0]!;
      expect(row.actor).toEqual({ kind, id: operatorId });
      let prepared = false;
      const sent: unknown[] = [];
      await runConnectionIntent(
        {
          uow,
          clock,
          identity: {
            tenantAccess: async () => {
              if (prepared) {
                const store = uow.store.for(TENANT);
                const actor =
                  kind === 'operator'
                    ? store.members.get(operatorId)!
                    : store.apiKeys.get(operatorId)!;
                actor.capabilities = ['connections:configure'];
              }
              return DEFAULT_ACCESS;
            },
          },
          sources: {
            [FORM_FEED_SOURCE]: {
              ...formFeedSource,
              prepare: async (ctx, intent) => {
                const result = await formFeedSource.prepare(ctx, intent);
                expect(result.ready).toBe(true);
                prepared = true;
                return result;
              },
            },
          },
          transport: {
            dispatch: async (input) => {
              sent.push(input.payload);
              return 'succeeded';
            },
          },
        },
        TENANT,
        row.id
      );
      expect(prepared).toBe(true);
      expect(sent).toEqual([]);
      expect((await intents())[0]).toMatchObject({ state: 'blocked', failure: 'authorization' });
    }
  );
});
