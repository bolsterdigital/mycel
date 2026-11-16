// A lead proposal sends only the prose an editor chose and writes one lead on acceptance.
// The fake model records the exact parts, so the data-minimisation claim is checked on what
// actually crossed the model boundary, not on what the code means to send.

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
import { LEAD_SOURCE_MAX, plainProse } from './lead.js';

const operator = principal({
  actor: { kind: 'operator', operatorId: '01900000-0000-7000-8000-00000000a001' },
  capabilities: ['tenant:admin', 'content:read', 'content:write', 'content:publish', 'ai:assist'],
});
const agent: Principal = { ...operator, actor: { kind: 'agent', sessionId: 's', keyId: 'k' } };
const apiKey: Principal = { ...operator, actor: { kind: 'api-key', keyId: 'k' } };

const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (value: string, marks?: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const prose = (...paragraphs: unknown[]) => ({ type: 'doc', content: paragraphs });
/** Two rich-text blocks never touch (ADR 020), so a quote sits between them. */
const quote = (id: string) =>
  ({
    id,
    type: 'quote',
    version: 1,
    props: { text: { nl: 'Quote secret' }, attribution: { name: 'Quote name' } },
  }) as never;
const block = (id: string, content: Record<string, unknown>) =>
  ({ id, type: 'rich-text', version: 1, props: { content } }) as never;

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
      lead: { nl: 'Oude lead', en: 'Old lead' },
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      blocks: [
        block('intro', {
          nl: prose(
            para(
              text('De '),
              text('bakker', [{ type: 'link', attrs: { href: 'https://secret.example/x' } }]),
              text(' bakt minder zout.'),
              text('1', [{ type: 'footnote_reference', attrs: { text: 'Private note' } }])
            ),
            { type: 'heading', attrs: { level: 1 }, content: [text('Tussenkop')] }
          ),
          en: prose(para(text('English secret'))),
        }),
        quote('q1'),
        block('skipped', { nl: prose(para(text('Unselected secret'))) }),
        quote('q2'),
        block('body', {
          nl: prose({
            type: 'bullet_list',
            content: [{ type: 'list_item', content: [para(text('Een punt'))] }],
          }),
        }),
      ],
    },
  });
  await invoker.run(useCases.updateAssistSettings, operator, {
    enabled: true,
    allowRestricted: false,
    consentedProvider: 'Fake model',
  });
  const input = {
    itemId: created.item.id,
    baseRevisionId: created.revision.id,
    locale: 'nl',
    blockIds: ['intro', 'body'],
  };
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

describe('lead proposal', () => {
  it('sends only the chosen blocks as plain text, then accepts one lead without publishing', async () => {
    const { invoker, model, created, input, run } = await setup();
    await invoker.run(useCases.publishItem, operator, {
      itemId: created.item.id,
      revisionId: created.revision.id,
      locale: 'nl',
    });
    await invoker.run(useCases.scheduleItem, operator, {
      itemId: created.item.id,
      revisionId: created.revision.id,
      locale: 'nl',
      at: '2030-01-01T09:00:00+01:00',
    });
    const before = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    const { suggestionId } = await invoker.run(useCases.suggestLead, operator, input);
    await run(suggestionId);
    const request = model.requests[0]!;
    expect(request.task).toBe('lead');
    expect(request.parts).toEqual([
      { kind: 'text', text: 'Locale: nl' },
      { kind: 'text', text: 'De bakker bakt minder zout.\n\nTussenkop' },
      { kind: 'text', text: 'Een punt' },
    ]);
    const sent = JSON.stringify(request.parts);
    for (const kept of [
      'Private title',
      'secret.example',
      'Private note',
      'Unselected secret',
      'Quote secret',
      'Quote name',
      'English secret',
      'Oude lead',
      'pepernoten',
    ])
      expect(sent).not.toContain(kept);
    const ready = await invoker.run(useCases.getSuggestion, operator, { suggestionId });
    expect(ready).toMatchObject({
      status: 'ready',
      task: 'lead',
      sourceBlockIds: ['intro', 'body'],
      model: 'fake-text',
    });
    const accepted = await invoker.run(useCases.acceptSuggestion, operator, {
      suggestionId,
      baseRevisionId: created.revision.id,
      value: '  Bakkers bakken minder zout.  ',
    });
    const after = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    expect(after.revision.id).toBe(accepted.revisionId);
    expect(after.revision.document.lead).toEqual({
      nl: 'Bakkers bakken minder zout.',
      en: 'Old lead',
    });
    expect(after.revision.document.blocks).toEqual(before.revision.document.blocks);
    expect(after.revision.document.title).toEqual(before.revision.document.title);
    expect(after.revision.provenance).toEqual({
      suggestionId,
      task: 'lead',
      provider: 'Fake model',
      model: 'fake-text',
      edited: true,
    });
    // Pointers and schedule unchanged; only the derived "unpublished changes" flag moves.
    const pointers = (p: typeof before.item.publication) =>
      p.map(({ hasUnpublishedChanges: _, ...rest }) => rest);
    expect(pointers(after.item.publication)).toEqual(pointers(before.item.publication));
    expect(after.item.publication[0]?.scheduleId).toBeTruthy();
    expect(JSON.stringify(after.revision.provenance)).not.toContain('bakt minder zout');
  });

  it('refuses a selection that is empty, too large, unordered, unknown, wordless or too long', async () => {
    const { invoker, input, created } = await setup();
    for (const blockIds of [
      [],
      ['intro', 'skipped', 'body', 'intro'],
      ['intro', 'intro'],
      ['body', 'intro'],
      ['missing'],
    ])
      await expect(
        invoker.run(useCases.suggestLead, operator, { ...input, blockIds })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      invoker.run(useCases.suggestLead, operator, { ...input, locale: 'en', blockIds: ['body'] })
    ).rejects.toMatchObject(refusal('lead-source'));
    await expect(
      invoker.run(useCases.suggestLead, operator, { ...input, locale: 'de' })
    ).rejects.toMatchObject(refusal('locale'));
    const long = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: {
        ...created.revision.document,
        blocks: [
          ...created.revision.document.blocks,
          quote('q3'),
          block('long', { nl: prose(para(text('x'.repeat(LEAD_SOURCE_MAX - 5)))) }),
        ],
      },
    });
    await expect(
      invoker.run(useCases.suggestLead, operator, {
        ...input,
        baseRevisionId: long.revision.id,
        blockIds: ['intro', 'long'],
      })
    ).rejects.toMatchObject(refusal('lead-too-long'));
    await expect(
      invoker.run(useCases.suggestLead, operator, {
        ...input,
        baseRevisionId: long.revision.id,
        blockIds: ['long'],
      })
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('is for articles only, and passes the shared consent, restricted and quota gate', async () => {
    const page = await setup('page');
    await expect(
      page.invoker.run(useCases.suggestLead, operator, page.input)
    ).rejects.toMatchObject(refusal('article'));
    const { uow, invoker, input, created } = await setup();
    await expect(
      invoker.run(
        useCases.suggestLead,
        { ...operator, entitlements: { ...operator.entitlements, 'ai.assist': false } },
        input
      )
    ).rejects.toMatchObject(refusal('ai-not-entitled', 'limit_exceeded'));
    await expect(
      invoker.run(
        useCases.suggestLead,
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
    await expect(invoker.run(useCases.suggestLead, operator, onRestricted)).rejects.toMatchObject(
      refusal('restricted-content')
    );
    await uow.run(operator, (ctx) =>
      ctx.assist.saveSettings({
        enabled: true,
        allowRestricted: true,
        consentedProvider: 'Old processor',
        consentedBy: null,
        consentedAt: new Date(),
      })
    );
    await expect(invoker.run(useCases.suggestLead, operator, onRestricted)).rejects.toMatchObject(
      refusal('consent-required')
    );
    // An API key with `ai:assist` may ask and read (ADR 021 rule 6).
    await uow.run(operator, (ctx) =>
      ctx.assist.saveSettings({
        enabled: true,
        allowRestricted: true,
        consentedProvider: 'Fake model',
        consentedBy: null,
        consentedAt: new Date(),
      })
    );
    await expect(invoker.run(useCases.suggestLead, apiKey, onRestricted)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('fails without a model call when the source changed or consent ended before the worker', async () => {
    const { uow, invoker, model, input, created, run } = await setup();
    const first = await invoker.run(useCases.suggestLead, operator, input);
    const second = await invoker.run(useCases.suggestLead, operator, input);
    await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: {
        ...created.revision.document,
        blocks: created.revision.document.blocks.filter((b) => b.id !== 'body'),
      },
    });
    await run(first.suggestionId);
    await uow.run(operator, (ctx) =>
      ctx.assist.saveSettings({
        enabled: false,
        allowRestricted: false,
        consentedProvider: null,
        consentedBy: null,
        consentedAt: null,
      })
    );
    await run(second.suggestionId);
    expect(model.requests).toHaveLength(0);
    for (const { suggestionId } of [first, second])
      expect(await invoker.run(useCases.getSuggestion, operator, { suggestionId })).toMatchObject({
        status: 'failed',
        failure: 'rejected',
        value: null,
      });
  });

  it.each([
    ['two lines', { lead: 'Eerste regel\ntweede regel' }],
    ['markup', { lead: 'Een <b>vette</b> lead' }],
    ['Markdown', { lead: 'Een **vette** lead' }],
    ['too long', { lead: 'x'.repeat(1001) }],
    ['another field', { lead: 'Lead', extra: true }],
  ])('stores invalid model output (%s) as a failure class only', async (_, result) => {
    const { invoker, model, input, run, log } = await setup();
    model.result = result;
    const { suggestionId } = await invoker.run(useCases.suggestLead, operator, input);
    await run(suggestionId);
    expect(await invoker.run(useCases.getSuggestion, operator, { suggestionId })).toMatchObject({
      status: 'failed',
      failure: 'invalid-output',
      value: null,
    });
    expect(JSON.stringify(log.lines)).not.toContain(String(result.lead).slice(0, 12));
  });

  it('lets only an operator accept, on the newest revision, with a valid lead', async () => {
    const { invoker, input, created, run } = await setup();
    const { suggestionId } = await invoker.run(useCases.suggestLead, operator, input);
    await run(suggestionId);
    const accept = { suggestionId, baseRevisionId: created.revision.id };
    for (const actor of [agent, apiKey])
      await expect(invoker.run(useCases.acceptSuggestion, actor, accept)).rejects.toMatchObject({
        code: 'forbidden',
      });
    for (const value of ['   ', 'x'.repeat(1001)])
      await expect(
        invoker.run(useCases.acceptSuggestion, operator, { ...accept, value })
      ).rejects.toMatchObject(refusal('lead-value'));
    const unchanged = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    expect(unchanged.revision.id).toBe(created.revision.id);
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

describe('plainProse', () => {
  it('keeps link words and line breaks, drops footnote markers and blank lines', () => {
    expect(
      plainProse(
        prose(
          para(text('Een'), { type: 'hard_break' }, text(' regel  verder')),
          para(),
          para(text('ref', [{ type: 'footnote_reference', attrs: { text: 'note' } }]))
        )
      )
    ).toBe('Een\nregel verder');
  });
});
