// A section proposal sends only the article's lead in one locale and the id and title of every
// section with a title in that locale; the model chooses one, the editor accepts it as a revision
// that changes only `sectionId`. The fake model records the exact parts, so the data-minimisation
// claim is checked on what actually crossed the model boundary.

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
import { sectionCandidates } from './section.js';

const operator = principal({
  actor: { kind: 'operator', operatorId: '01900000-0000-7000-8000-00000000a001' },
  capabilities: ['tenant:admin', 'content:read', 'content:write', 'content:publish', 'ai:assist'],
});
const agent: Principal = { ...operator, actor: { kind: 'agent', sessionId: 's', keyId: 'k' } };
const apiKey: Principal = { ...operator, actor: { kind: 'api-key', keyId: 'k' } };

const LEAD =
  'Bakkers bakken dit jaar pepernoten met minder zout. De smaak van het eten blijft gelijk.';

async function setup(type: 'article' | 'page' = 'article') {
  const log = new MemoryLogger();
  const uow = new MemoryUnitOfWork({ assistProviderLabel: 'Fake model', log });
  const invoker = new Invoker(buildRegistry(), uow);
  const model = new FakeTextModel();
  const section = (slug: string, title: Record<string, string>, description?: string) =>
    invoker.run(useCases.createSection, operator, {
      slug,
      title,
      ...(description ? { description: { nl: description } } : {}),
    });
  const politics = await section('politiek', { nl: 'Politiek', en: 'Politics' }, 'Secret about');
  const food = await section('eten', { nl: 'Eten en drinken' });
  const english = await section('only-en', { en: 'English only' });
  const created = await invoker.run(useCases.createItem, operator, {
    slug: 'pepernoten',
    document: {
      type,
      title: { nl: 'Private title', en: 'Private title en' },
      lead: { nl: `  ${LEAD}  `, en: 'English secret lead' },
      seo: { title: { nl: 'Seo secret' } },
      defaultLocale: 'nl',
      locales: ['nl', 'en', 'de'],
      ...(type === 'article' ? { tags: ['tag-secret'] } : {}),
      blocks: [],
    } as never,
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
  return { uow, invoker, model, created, input, run, log, politics, food, english };
}

const refusal = (message: string, code = 'invalid_input') => ({
  code,
  issues: [{ path: '', message: `assist.error.${message}` }],
});

describe('section candidates', () => {
  const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  it('offers every section titled in the locale, in id order, within the bounds', () => {
    expect(
      sectionCandidates(
        [
          { id: id(2), title: { nl: ' B ' } },
          { id: id(1), title: { nl: 'A' } },
          { id: id(3), title: { en: 'C' } },
        ],
        'nl'
      )
    ).toEqual({
      ok: true,
      candidates: [
        { id: id(1), title: 'A' },
        { id: id(2), title: 'B' },
      ],
    });
    const many = (n: number, title = 'x') =>
      Array.from({ length: n }, (_, i) => ({ id: id(i), title: { nl: title } }));
    expect(sectionCandidates(many(1), 'nl').ok).toBe(false);
    expect(sectionCandidates(many(20), 'nl').ok).toBe(true);
    expect(sectionCandidates(many(21), 'nl').ok).toBe(false);
    expect(sectionCandidates(many(11, 'x'.repeat(190)), 'nl').ok).toBe(false);
  });
});

describe('section proposal', () => {
  it('sends only the lead, the locale and the offered sections, then accepts one section', async () => {
    const { invoker, model, created, input, run, politics, food } = await setup();
    await invoker.run(useCases.publishItem, operator, {
      itemId: created.item.id,
      revisionId: created.revision.id,
      locale: 'nl',
    });
    const before = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    const { suggestionId } = await invoker.run(useCases.suggestSection, operator, input);
    await run(suggestionId);
    const request = model.requests[0]!;
    expect(request.task).toBe('section');
    const offered = [politics, food]
      .map((s) => ({ id: s.id, title: s.title.nl! }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(request.parts).toEqual([
      { kind: 'text', text: 'Locale: nl' },
      { kind: 'text', text: LEAD },
      { kind: 'text', text: JSON.stringify(offered) },
    ]);
    const sent = JSON.stringify(request.parts);
    for (const kept of [
      'Private title',
      'English',
      'Seo secret',
      'tag-secret',
      'Secret about',
      'politiek',
      'Politics',
    ])
      expect(sent).not.toContain(kept);
    expect(await invoker.run(useCases.getSuggestion, operator, { suggestionId })).toMatchObject({
      status: 'ready',
      task: 'section',
      value: food.id,
      model: 'fake-text',
    });
    const accepted = await invoker.run(useCases.acceptSuggestion, operator, {
      suggestionId,
      baseRevisionId: created.revision.id,
    });
    const after = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    expect(after.revision.id).toBe(accepted.revisionId);
    const { sectionId, ...restAfter } = after.revision.document as { sectionId: string };
    const { sectionId: was, ...restBefore } = before.revision.document as { sectionId: null };
    expect([was, sectionId]).toEqual([null, food.id]);
    expect(restAfter).toEqual(restBefore);
    expect(after.revision.provenance).toEqual({
      suggestionId,
      task: 'section',
      provider: 'Fake model',
      model: 'fake-text',
      edited: false,
    });
    const pointers = (p: typeof before.item.publication) =>
      p.map(({ hasUnpublishedChanges: _, ...rest }) => rest);
    expect(pointers(after.item.publication)).toEqual(pointers(before.item.publication));
  });

  it('writes no revision when the article is already in the proposed section', async () => {
    const { invoker, created, run, food } = await setup();
    const inFood = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: { ...created.revision.document, sectionId: food.id } as never,
    });
    const { suggestionId } = await invoker.run(useCases.suggestSection, operator, {
      itemId: created.item.id,
      baseRevisionId: inFood.revision.id,
      locale: 'nl',
    });
    await run(suggestionId);
    const accepted = await invoker.run(useCases.acceptSuggestion, operator, {
      suggestionId,
      baseRevisionId: inFood.revision.id,
    });
    expect(accepted.revisionId).toBe(inFood.revision.id);
    expect(await invoker.run(useCases.getSuggestion, operator, { suggestionId })).toMatchObject({
      status: 'accepted',
    });
  });

  it('needs a lead of 50 to 1,000 characters and two titled sections in the asked locale', async () => {
    const { invoker, input, created } = await setup();
    // `de` has no lead; `en` has a short lead and only one section titled in English.
    for (const locale of ['de', 'en'])
      await expect(
        invoker.run(useCases.suggestSection, operator, { ...input, locale })
      ).rejects.toMatchObject(refusal('section-source'));
    await expect(
      invoker.run(useCases.suggestSection, operator, { ...input, locale: 'fr' })
    ).rejects.toMatchObject(refusal('locale'));
    const english = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: {
        ...created.revision.document,
        lead: { ...created.revision.document.lead, en: 'x'.repeat(60) },
      },
    });
    await expect(
      invoker.run(useCases.suggestSection, operator, {
        ...input,
        baseRevisionId: english.revision.id,
        locale: 'en',
      })
    ).resolves.toMatchObject({ status: 'pending' });
    const one = await setup();
    const nl = await one.invoker.run(useCases.getSection, operator, {
      sectionId: one.politics.id,
    });
    await one.invoker.run(useCases.updateSection, operator, {
      sectionId: nl.id,
      baseUpdatedAt: nl.updatedAt,
      title: { en: 'Politics' },
    });
    await expect(
      one.invoker.run(useCases.suggestSection, operator, one.input)
    ).rejects.toMatchObject(refusal('section-candidates'));
  });

  it('is for articles only, and passes the shared consent, restricted and quota gate', async () => {
    const page = await setup('page');
    await expect(
      page.invoker.run(useCases.suggestSection, operator, page.input)
    ).rejects.toMatchObject(refusal('article'));
    const { invoker, input, created } = await setup();
    await expect(
      invoker.run(
        useCases.suggestSection,
        { ...operator, entitlements: { ...operator.entitlements, 'ai.monthly_max': 0 } },
        input
      )
    ).rejects.toMatchObject(refusal('limit-reached', 'limit_exceeded'));
    const restricted = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: { ...created.revision.document, access: { level: 'members', teaser: 'lead' } },
    });
    await expect(
      invoker.run(useCases.suggestSection, operator, {
        ...input,
        baseRevisionId: restricted.revision.id,
      })
    ).rejects.toMatchObject(refusal('restricted-content'));
    // An API key with `ai:assist` may ask (ADR 021 rule 6).
    const other = await setup();
    await expect(
      other.invoker.run(useCases.suggestSection, apiKey, other.input)
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('fails without a model call when a section changed before the worker', async () => {
    const { invoker, model, input, run, politics } = await setup();
    const { suggestionId } = await invoker.run(useCases.suggestSection, operator, input);
    await invoker.run(useCases.updateSection, operator, {
      sectionId: politics.id,
      baseUpdatedAt: politics.updatedAt,
      title: { nl: 'Binnenland' },
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
    ['an id that was not offered', { sectionId: '01900000-0000-7000-8000-0000000000ff' }],
    ['not an id', { sectionId: 'Eten en drinken' }],
    ['another field', { sectionId: '01900000-0000-7000-8000-0000000000ff', extra: true }],
  ])('stores invalid model output (%s) as a failure class only', async (_, result) => {
    const { invoker, model, input, run, log } = await setup();
    model.result = result;
    const { suggestionId } = await invoker.run(useCases.suggestSection, operator, input);
    await run(suggestionId);
    expect(await invoker.run(useCases.getSuggestion, operator, { suggestionId })).toMatchObject({
      status: 'failed',
      failure: 'invalid-output',
      value: null,
    });
    expect(JSON.stringify(log.lines)).not.toContain(String(result.sectionId));
  });

  it('lets only an operator accept the proposed id, while the sections are unchanged', async () => {
    const { invoker, input, created, run, food, politics } = await setup();
    const { suggestionId } = await invoker.run(useCases.suggestSection, operator, input);
    await run(suggestionId);
    const accept = { suggestionId, baseRevisionId: created.revision.id };
    for (const actor of [agent, apiKey])
      await expect(invoker.run(useCases.acceptSuggestion, actor, accept)).rejects.toMatchObject({
        code: 'forbidden',
      });
    await expect(
      invoker.run(useCases.acceptSuggestion, operator, { ...accept, value: politics.id })
    ).rejects.toMatchObject(refusal('section-value'));
    const renamed = await invoker.run(useCases.updateSection, operator, {
      sectionId: food.id,
      baseUpdatedAt: food.updatedAt,
      title: { nl: 'Eten' },
    });
    await expect(invoker.run(useCases.acceptSuggestion, operator, accept)).rejects.toMatchObject(
      refusal('stale', 'conflict')
    );
    // Renamed back, the offered list is the same again and the proposal can be taken.
    await invoker.run(useCases.updateSection, operator, {
      sectionId: food.id,
      baseUpdatedAt: renamed.updatedAt,
      title: { nl: 'Eten en drinken' },
    });
    await expect(invoker.run(useCases.acceptSuggestion, operator, accept)).resolves.toMatchObject({
      revisionId: expect.any(String),
    });
  });
});
