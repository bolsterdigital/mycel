// The domain proof follows a proposal across the job boundary and one editorial acceptance.
// A provider error and a stale revision exercise the two paths most likely to leak content or
// silently overwrite an editor. Adapter tests separately prove that variants have no EXIF.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Principal } from '../principal.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { EXAMPLE_PNG } from '../media/service.js';
import { FakeClock, FakeTextModel, MemoryLogger, MemoryUnitOfWork } from '../testing/index.js';
import { runAssistSuggestion } from './worker.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const system = systemPrincipal(TENANT, 'test');
const operator: Principal = {
  ...system,
  actor: {
    kind: 'operator',
    operatorId: '01900000-0000-7000-8000-00000000a001',
    email: 'editor@probe.test',
  },
  capabilities: ['tenant:admin', 'content:read', 'content:write', 'content:publish', 'ai:assist'],
};

async function setup() {
  const log = new MemoryLogger();
  const uow = new MemoryUnitOfWork({ assistProviderLabel: 'Fake model', log });
  const invoker = new Invoker(buildRegistry(), uow);
  const model = new FakeTextModel();
  const media = await invoker.run(useCases.uploadMedia, system, {
    filename: 'private-source.png',
    contentType: 'image/png',
    bytes: EXAMPLE_PNG,
    credit: {
      work: { title: 'Private credit', maker: 'Private maker' },
      photographer: 'Private photographer',
    },
  });
  const created = await invoker.run(useCases.createItem, system, {
    slug: 'assist-image',
    document: {
      type: 'page',
      title: { nl: 'Private title', en: 'Private title en' },
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      blocks: [
        {
          id: 'photo',
          type: 'image',
          version: 1,
          props: {
            mediaId: media.id,
            decorative: false,
            alt: { nl: 'Voorlopig', en: 'Temporary' },
            caption: { nl: 'Visible caption' },
            layout: 'content',
          },
        },
      ],
    },
  });
  await invoker.run(useCases.updateAssistSettings, operator, {
    enabled: true,
    allowRestricted: false,
    consentedProvider: 'Fake model',
  });
  const suggest = () =>
    invoker.run(useCases.suggestAlt, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      blockId: 'photo',
      locale: 'nl',
    });
  const run = (suggestionId: string, attempts = 2) =>
    runAssistSuggestion({
      uow,
      model,
      tenantId: TENANT,
      suggestionId,
      attempts,
      timeoutMs: 1000,
      now: () => uow.clock.now(),
    });
  return { uow, invoker, model, created, suggest, run, log };
}

describe('assistance proposal boundary', () => {
  it('sends only the selected variant, caption and locale, then accepts without publishing', async () => {
    const { uow, invoker, model, created, suggest, run } = await setup();
    await invoker.run(useCases.publishItem, operator, {
      itemId: created.item.id,
      revisionId: created.revision.id,
      locale: 'nl',
    });
    const { suggestionId } = await suggest();
    expect(await run(suggestionId)).toEqual({});
    const request = model.requests[0]!;
    expect(request.task).toBe('alt');
    expect(request.parts).toHaveLength(2);
    expect(request.parts[0]).toEqual({
      kind: 'text',
      text: 'Locale: nl\nCaption: Visible caption',
    });
    expect(request.parts[1]).toMatchObject({ kind: 'image', contentType: 'image/webp' });
    const sent = JSON.stringify(request.parts[0]);
    for (const privateValue of [
      'Private title',
      'Private credit',
      'Private maker',
      'Private photographer',
      'private-source.png',
      'Temporary',
    ])
      expect(sent).not.toContain(privateValue);
    const accepted = await invoker.run(useCases.acceptSuggestion, operator, {
      suggestionId,
      baseRevisionId: created.revision.id,
      value: 'Aangepaste beschrijving',
    });
    const current = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    expect(current.revision.id).toBe(accepted.revisionId);
    expect(current.revision.provenance).toMatchObject({
      suggestionId,
      task: 'alt',
      provider: 'Fake model',
      edited: true,
    });
    expect(current.item.publication.find((p) => p.locale === 'nl')?.publishedRevisionId).toBe(
      created.revision.id
    );
    expect(
      (await invoker.run(useCases.getSuggestion, operator, { suggestionId })).value
    ).toBeNull();
    expect((await uow.run(operator, (ctx) => ctx.assist.get(suggestionId)))?.status).toBe(
      'accepted'
    );
  });

  it('records only a failure class, and retention removes the transient result', async () => {
    const { uow, invoker, model, suggest, run, log } = await setup();
    model.failure = 'rejected';
    const { suggestionId } = await suggest();
    await run(suggestionId);
    const failed = await invoker.run(useCases.getSuggestion, operator, { suggestionId });
    expect(failed).toMatchObject({ status: 'failed', failure: 'rejected', value: null });
    expect(await invoker.run(useCases.dismissSuggestion, operator, { suggestionId })).toMatchObject(
      { status: 'dismissed', value: null }
    );
    expect(JSON.stringify(log.lines)).not.toContain('Visible caption');
    expect(JSON.stringify(log.lines)).not.toContain('Private title');
    const deleted = await uow.run(system, (ctx) => ctx.assist.deleteBefore(new Date('2026-10-22')));
    expect(deleted).toBe(1);
    expect(await uow.run(system, (ctx) => ctx.assist.get(suggestionId))).toBeNull();
    expect(await uow.run(system, (ctx) => ctx.assist.countSince(new Date('2026-10-01')))).toBe(1);
  });

  it('refuses an agent acceptance and a stale proposal after another revision', async () => {
    const { invoker, created, suggest, run } = await setup();
    const { suggestionId } = await suggest();
    await run(suggestionId);
    const agent: Principal = {
      ...operator,
      actor: { kind: 'agent', sessionId: 'one', keyId: 'one' },
    };
    await expect(
      invoker.run(useCases.acceptSuggestion, agent, {
        suggestionId,
        baseRevisionId: created.revision.id,
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const changed = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: created.revision.document,
    });
    await expect(
      invoker.run(useCases.acceptSuggestion, operator, {
        suggestionId,
        baseRevisionId: created.revision.id,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      invoker.run(useCases.acceptSuggestion, operator, {
        suggestionId,
        baseRevisionId: changed.revision.id,
      })
    ).rejects.toMatchObject({
      code: 'conflict',
      issues: [{ path: '', message: 'assist.error.stale' }],
    });
  });

  it.each(['timeout', 'invalid-output', 'unavailable'] as const)(
    'stores %s without provider content',
    async (failure) => {
      const { invoker, model, suggest, run, log } = await setup();
      if (failure === 'invalid-output') model.result = { alt: 'invalid\nline' };
      else model.failure = failure;
      const { suggestionId } = await suggest();
      await run(suggestionId);
      const row = await invoker.run(useCases.getSuggestion, operator, { suggestionId });
      expect(row).toMatchObject({ status: 'failed', failure, value: null });
      expect(JSON.stringify(log.lines)).not.toContain('invalid\nline');
    }
  );

  it('refuses disabled, unconsented, restricted, over-limit and unauthorized requests', async () => {
    const { uow, invoker, created } = await setup();
    const input = {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      blockId: 'photo',
      locale: 'nl',
    };
    const key: Principal = {
      ...operator,
      actor: { kind: 'api-key', keyId: 'one' },
      capabilities: ['content:read'],
    };
    await expect(invoker.run(useCases.suggestAlt, key, input)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      invoker.run(
        useCases.suggestAlt,
        { ...operator, entitlements: { ...operator.entitlements, 'ai.assist': false } },
        input
      )
    ).rejects.toMatchObject({
      code: 'limit_exceeded',
      issues: [{ path: '', message: 'assist.error.ai-not-entitled' }],
    });
    await expect(
      invoker.run(
        useCases.suggestAlt,
        { ...operator, entitlements: { ...operator.entitlements, 'ai.monthly_max': 0 } },
        input
      )
    ).rejects.toMatchObject({
      code: 'limit_exceeded',
      issues: [{ path: '', message: 'assist.error.limit-reached' }],
    });
    await uow.run(operator, (ctx) =>
      ctx.assist.saveSettings({
        enabled: false,
        allowRestricted: false,
        consentedProvider: null,
        consentedBy: null,
        consentedAt: null,
      })
    );
    await expect(invoker.run(useCases.suggestAlt, operator, input)).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [{ path: '', message: 'assist.error.ai-disabled' }],
    });
    await uow.run(operator, (ctx) =>
      ctx.assist.saveSettings({
        enabled: true,
        allowRestricted: false,
        consentedProvider: 'Old processor',
        consentedBy: null,
        consentedAt: new Date(),
      })
    );
    await expect(invoker.run(useCases.suggestAlt, operator, input)).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [{ path: '', message: 'assist.error.consent-required' }],
    });
    await uow.run(operator, (ctx) =>
      ctx.assist.saveSettings({
        enabled: true,
        allowRestricted: false,
        consentedProvider: 'Fake model',
        consentedBy: null,
        consentedAt: new Date(),
      })
    );
    const restricted = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: {
        ...created.revision.document,
        access: { level: 'members', teaser: { blocks: 0 } },
      },
    });
    await expect(
      invoker.run(useCases.suggestAlt, operator, {
        ...input,
        baseRevisionId: restricted.revision.id,
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [{ path: '', message: 'assist.error.restricted-content' }],
    });
  });

  it('counts an operator’s last hour as a sliding window', async () => {
    const { uow, invoker, created, suggest } = await setup();
    await uow.run(operator, async (ctx) => {
      for (let index = 0; index < 30; index++)
        await ctx.assist.insert({
          id: ctx.ids.next(),
          itemId: created.item.id,
          baseRevisionId: created.revision.id,
          blockId: 'photo',
          locale: 'nl',
          status: 'failed',
          value: null,
          failure: 'rejected',
          provider: 'Fake model',
          requestedBy: operator.actor.kind === 'operator' ? operator.actor.operatorId : null,
          model: null,
          createdAt: new Date(ctx.clock.now().getTime() - 3_599_000),
          updatedAt: ctx.clock.now(),
        });
    });
    await expect(suggest()).rejects.toMatchObject({
      code: 'limit_exceeded',
      issues: [{ path: '', message: 'assist.error.limit-reached' }],
    });
  });

  it('shows a stale pending job as failed before a worker reaches it', async () => {
    const { uow, invoker, suggest, run } = await setup();
    const { suggestionId } = await suggest();
    (uow.clock as FakeClock).advance(11 * 60_000);
    expect(await invoker.run(useCases.getSuggestion, operator, { suggestionId })).toMatchObject({
      status: 'failed',
      failure: 'timeout',
    });
    await run(suggestionId);
    expect((await uow.run(operator, (ctx) => ctx.assist.get(suggestionId)))?.status).toBe('failed');
  });
});
