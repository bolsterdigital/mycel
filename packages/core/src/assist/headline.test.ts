// A headline proposal sends only the article's lead in one locale and writes one title on
// acceptance. The fake model records the exact parts, so the data-minimisation claim is checked
// on what actually crossed the model boundary, not on what the code means to send.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { type Principal } from '../principal.js';
import { buildRegistry, useCases } from '../use-cases.js';
import {
  FakeTextModel,
  MemoryLogger,
  MemoryUnitOfWork,
  TENANT,
  principal,
} from '../testing/index.js';
import { runAssistSuggestion } from './worker.js';
import { HEADLINE_SOURCE_MAX } from './headline.js';

const operator = principal({
  actor: { kind: 'operator', operatorId: '01900000-0000-7000-8000-00000000a001' },
  capabilities: ['tenant:admin', 'content:read', 'content:write', 'content:publish', 'ai:assist'],
});
const agent: Principal = { ...operator, actor: { kind: 'agent', sessionId: 's', keyId: 'k' } };
const apiKey: Principal = { ...operator, actor: { kind: 'api-key', keyId: 'k' } };

const LEAD = 'Bakkers bakken dit jaar pepernoten met minder zout. De smaak blijft gelijk.';

async function setup(type: 'article' | 'page' = 'article') {
  const log = new MemoryLogger();
  const uow = new MemoryUnitOfWork({ assistProviderLabel: 'Fake model', log });
  const invoker = new Invoker(buildRegistry(), uow);
  const model = new FakeTextModel();
  const created = await invoker.run(useCases.createItem, operator, {
    slug: 'pepernoten',
    document: {
      type,
      title: { nl: 'Private title', en: 'Private title en' },
      lead: { nl: `  ${LEAD}  `, en: 'English secret lead' },
      seo: { title: { nl: 'Seo secret' }, description: { nl: 'Seo description secret' } },
      defaultLocale: 'nl',
      locales: ['nl', 'en', 'de'],
      blocks: [
        {
          id: 'body',
          type: 'rich-text',
          version: 1,
          props: {
            content: {
              nl: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Block secret' }] }],
              },
            },
          },
        } as never,
      ],
    },
  });
  await invoker.run(useCases.updateAssistSettings, operator, {
    enabled: true,
    allowRestricted: false,
    consentedProvider: 'Fake model',
  });
  const input = { itemId: created.item.id, baseRevisionId: created.revision.id, locale: 'nl' };
  const run = (suggestionId: string) =>
    runAssistSuggestion({
      uow,
      model,
      tenantId: TENANT,
      suggestionId,
      attempts: 2,
      timeoutMs: 1000,
      now: () => uow.clock.now(),
    });
  return { uow, invoker, model, created, input, run, log };
}

const refusal = (message: string, code = 'invalid_input') => ({
  code,
  issues: [{ path: '', message: `assist.error.${message}` }],
});

describe('headline proposal', () => {
  it('sends only the lead and the locale, then accepts one title without publishing', async () => {
    const { invoker, model, created, input, run } = await setup();
    await invoker.run(useCases.publishItem, operator, {
      itemId: created.item.id,
      revisionId: created.revision.id,
      locale: 'nl',
    });
    const before = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    const { suggestionId } = await invoker.run(useCases.suggestHeadline, operator, input);
    await run(suggestionId);
    const request = model.requests[0]!;
    expect(request.task).toBe('headline');
    expect(request.parts).toEqual([
      { kind: 'text', text: 'Locale: nl' },
      { kind: 'text', text: LEAD },
    ]);
    const sent = JSON.stringify(request.parts);
    for (const kept of [
      'Private title',
      'English secret',
      'Seo secret',
      'Seo description secret',
      'Block secret',
    ])
      expect(sent).not.toContain(kept);
    expect(await invoker.run(useCases.getSuggestion, operator, { suggestionId })).toMatchObject({
      status: 'ready',
      task: 'headline',
      value: 'Bakkers bakken dit jaar pepernoten met minder zout',
      model: 'fake-text',
    });
    const accepted = await invoker.run(useCases.acceptSuggestion, operator, {
      suggestionId,
      baseRevisionId: created.revision.id,
      value: '  Minder zout in de pepernoten  ',
    });
    const after = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    expect(after.revision.id).toBe(accepted.revisionId);
    expect(after.revision.document.title).toEqual({
      nl: 'Minder zout in de pepernoten',
      en: 'Private title en',
    });
    const { title: _a, ...restAfter } = after.revision.document;
    const { title: _b, ...restBefore } = before.revision.document;
    expect(restAfter).toEqual(restBefore);
    expect(after.revision.provenance).toEqual({
      suggestionId,
      task: 'headline',
      provider: 'Fake model',
      model: 'fake-text',
      edited: true,
    });
    const pointers = (p: typeof before.item.publication) =>
      p.map(({ hasUnpublishedChanges: _, ...rest }) => rest);
    expect(pointers(after.item.publication)).toEqual(pointers(before.item.publication));
    expect(JSON.stringify(after.revision.provenance)).not.toContain('minder zout');
  });

  it('needs a lead in the asked locale, never another one, within the bound', async () => {
    const { invoker, input, created } = await setup();
    await expect(
      invoker.run(useCases.suggestHeadline, operator, { ...input, locale: 'de' })
    ).rejects.toMatchObject(refusal('headline-source'));
    await expect(
      invoker.run(useCases.suggestHeadline, operator, { ...input, locale: 'fr' })
    ).rejects.toMatchObject(refusal('locale'));
    const long = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: {
        ...created.revision.document,
        lead: { ...created.revision.document.lead, de: 'x'.repeat(HEADLINE_SOURCE_MAX) },
      },
    });
    await expect(
      invoker.run(useCases.suggestHeadline, operator, {
        ...input,
        baseRevisionId: long.revision.id,
        locale: 'de',
      })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('is for articles only, and passes the shared consent, restricted and quota gate', async () => {
    const page = await setup('page');
    await expect(
      page.invoker.run(useCases.suggestHeadline, operator, page.input)
    ).rejects.toMatchObject(refusal('article'));
    const { uow, invoker, input, created } = await setup();
    await expect(
      invoker.run(
        useCases.suggestHeadline,
        { ...operator, entitlements: { ...operator.entitlements, 'ai.monthly_max': 0 } },
        input
      )
    ).rejects.toMatchObject(refusal('limit-reached', 'limit_exceeded'));
    const restricted = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: { ...created.revision.document, access: { level: 'members', teaser: 'lead' } },
    });
    const onRestricted = { ...input, baseRevisionId: restricted.revision.id };
    await expect(
      invoker.run(useCases.suggestHeadline, operator, onRestricted)
    ).rejects.toMatchObject(refusal('restricted-content'));
    await uow.run(operator, (ctx) =>
      ctx.assist.saveSettings({
        enabled: true,
        allowRestricted: true,
        consentedProvider: 'Fake model',
        consentedBy: null,
        consentedAt: new Date(),
      })
    );
    // An API key with `ai:assist` may ask and read (ADR 021 rule 6).
    await expect(
      invoker.run(useCases.suggestHeadline, apiKey, onRestricted)
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('fails without a model call when the lead changed before the worker, never using the newer one', async () => {
    const { invoker, model, input, created, run } = await setup();
    const { suggestionId } = await invoker.run(useCases.suggestHeadline, operator, input);
    await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: { ...created.revision.document, lead: { nl: 'Een nieuwere lead' } },
    });
    await run(suggestionId);
    expect(model.requests).toHaveLength(0);
    expect(await invoker.run(useCases.getSuggestion, operator, { suggestionId })).toMatchObject({
      status: 'failed',
      failure: 'rejected',
      value: null,
    });
  });

  it.each([
    ['two lines', { headline: 'Eerste regel\ntweede regel' }],
    ['markup', { headline: 'Een <b>vette</b> kop' }],
    ['Markdown', { headline: 'Een **vette** kop' }],
    ['too long', { headline: 'x'.repeat(201) }],
    ['another field', { headline: 'Kop', extra: true }],
  ])('stores invalid model output (%s) as a failure class only', async (_, result) => {
    const { invoker, model, input, run, log } = await setup();
    model.result = result;
    const { suggestionId } = await invoker.run(useCases.suggestHeadline, operator, input);
    await run(suggestionId);
    expect(await invoker.run(useCases.getSuggestion, operator, { suggestionId })).toMatchObject({
      status: 'failed',
      failure: 'invalid-output',
      value: null,
    });
    expect(JSON.stringify(log.lines)).not.toContain(String(result.headline).slice(0, 12));
  });

  it('lets only an operator accept, on the newest revision, with a valid title', async () => {
    const { invoker, input, created, run } = await setup();
    const { suggestionId } = await invoker.run(useCases.suggestHeadline, operator, input);
    await run(suggestionId);
    const accept = { suggestionId, baseRevisionId: created.revision.id };
    for (const actor of [agent, apiKey])
      await expect(invoker.run(useCases.acceptSuggestion, actor, accept)).rejects.toMatchObject({
        code: 'forbidden',
      });
    for (const value of ['   ', 'x'.repeat(201)])
      await expect(
        invoker.run(useCases.acceptSuggestion, operator, { ...accept, value })
      ).rejects.toMatchObject(refusal('headline-value'));
    const changed = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: created.revision.document,
    });
    await expect(
      invoker.run(useCases.acceptSuggestion, operator, {
        suggestionId,
        baseRevisionId: changed.revision.id,
      })
    ).rejects.toMatchObject(refusal('stale', 'conflict'));
    expect(await invoker.run(useCases.dismissSuggestion, operator, { suggestionId })).toMatchObject(
      { status: 'dismissed' }
    );
    const after = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    expect(after.revision.id).toBe(changed.revision.id);
  });
});
