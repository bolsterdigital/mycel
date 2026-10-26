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
import { readinessIssues } from '../content/model.js';

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

describe('translation boundary', () => {
  it.each(['remove', 'move'] as const)(
    'keeps an accepted translation unreviewed when %s merges its block',
    async (operation) => {
      const { invoker, run, created } = await setup();
      const text = (value: string) => ({
        type: 'doc' as const,
        content: [
          { type: 'paragraph' as const, content: [{ type: 'text' as const, text: value }] },
        ],
      });
      const rich = (id: string) => ({
        id,
        type: 'rich-text' as const,
        version: 1 as const,
        props: { content: { nl: text(id), en: text(id) } },
      });
      const prepared = await invoker.run(useCases.updateItem, operator, {
        itemId: created.item.id,
        baseRevisionId: created.revision.id,
        document: {
          ...created.revision.document,
          blocks: [
            rich('first'),
            {
              id: 'separator',
              type: 'heading',
              version: 1,
              props: { text: { nl: 'Kop', en: 'Heading' } },
            },
            rich('second'),
          ],
        },
      });
      const suggested = await invoker.run(useCases.suggestTranslation, operator, {
        itemId: created.item.id,
        baseRevisionId: prepared.revision.id,
        from: 'nl',
        to: 'en',
        targets: ['second'],
      });
      await run(suggested.suggestionId);
      const accepted = await invoker.run(useCases.acceptSuggestion, operator, {
        suggestionId: suggested.suggestionId,
        baseRevisionId: prepared.revision.id,
      });
      const agent = { ...system, capabilities: ['content:write', 'content:publish'] as const };
      const target = { itemId: created.item.id, baseRevisionId: accepted.revisionId };
      const changed =
        operation === 'remove'
          ? await invoker.run(useCases.removeBlock, agent, { ...target, blockId: 'separator' })
          : await invoker.run(useCases.moveBlock, agent, {
              ...target,
              blockId: 'separator',
              place: { at: 'end' },
            });
      expect(changed.merged).toEqual([{ from: 'second', into: 'first' }]);
      expect(JSON.stringify(changed.revision.document.blocks)).toContain('[en] second');
      expect(changed.revision.document.machineTranslation?.en).toEqual([
        'blocks.first.props.content',
      ]);
      expect(readinessIssues(changed.revision.document, 'en')).toContainEqual({
        path: 'blocks.first.props.content',
        message: 'content.publish.machine-translation-unreviewed',
      });
      await expect(
        invoker.run(useCases.publishItem, agent, {
          itemId: created.item.id,
          revisionId: changed.revision.id,
          locale: 'en',
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        invoker.run(useCases.approveTranslation, agent, {
          itemId: created.item.id,
          locale: 'en',
          baseRevisionId: changed.revision.id,
        })
      ).rejects.toMatchObject({ code: 'forbidden' });
      const approved = await invoker.run(useCases.approveTranslation, operator, {
        itemId: created.item.id,
        locale: 'en',
        baseRevisionId: changed.revision.id,
      });
      const afterApproval = await invoker.run(useCases.getItem, operator, {
        itemId: created.item.id,
      });
      expect(afterApproval.revision.document.machineTranslation?.en).toBeUndefined();
      await invoker.run(useCases.publishItem, agent, {
        itemId: created.item.id,
        revisionId: approved.revisionId,
        locale: 'en',
      });
    }
  );

  it('sends only selected Markdown, rejects changed structure, and needs a human publisher', async () => {
    const { uow, invoker, model, created, run } = await setup();
    const source = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Source ', marks: [] },
            {
              type: 'text',
              text: 'link',
              marks: [{ type: 'link', attrs: { href: 'https://example.org/source' } }],
            },
            {
              type: 'text',
              text: ' note',
              marks: [{ type: 'footnote_reference', attrs: { text: 'Reference' } }],
            },
          ],
        },
      ],
    };
    const changed = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      document: {
        ...created.revision.document,
        blocks: [
          ...created.revision.document.blocks.map((block) =>
            block.type === 'image'
              ? {
                  ...block,
                  props: {
                    ...block.props,
                    caption: { nl: 'Visible caption', en: 'Visible caption en' },
                  },
                }
              : block
          ),
          { id: 'body', type: 'rich-text', version: 1, props: { content: { nl: source } } },
        ],
      },
    });
    const input = {
      itemId: created.item.id,
      baseRevisionId: changed.revision.id,
      from: 'nl',
      to: 'en',
      targets: ['body'],
    };
    const first = await invoker.run(useCases.suggestTranslation, operator, input);
    const original = 'Source [link](https://example.org/source)[ note][^1]\n\n[^1]: Reference';
    model.result = {
      values: {
        'blocks.body.props.content':
          'Translated [link](https://example.org/changed)[ note][^1]\n\n[^1]: Reference',
      },
    };
    await run(first.suggestionId);
    expect(model.requests.at(-1)?.parts).toEqual([
      {
        kind: 'text',
        text: JSON.stringify({
          from: 'nl',
          to: 'en',
          values: { 'blocks.body.props.content': original },
        }),
      },
    ]);
    expect(
      (await invoker.run(useCases.getSuggestion, operator, { suggestionId: first.suggestionId }))
        .failure
    ).toBe('invalid-output');
    const second = await invoker.run(useCases.suggestTranslation, operator, input);
    model.result = {
      values: {
        'blocks.body.props.content':
          'Translated [link](https://example.org/source)[ note][^2]\n\n[^2]: Reference',
      },
    };
    await run(second.suggestionId);
    expect(
      (await invoker.run(useCases.getSuggestion, operator, { suggestionId: second.suggestionId }))
        .failure
    ).toBe('invalid-output');
    const third = await invoker.run(useCases.suggestTranslation, operator, input);
    model.result = {
      values: {
        'blocks.body.props.content':
          'Translated [link](https://example.org/source)[ note][^1]\n\n[^1]: Reference',
      },
    };
    await run(third.suggestionId);
    const accepted = await invoker.run(useCases.acceptSuggestion, operator, {
      suggestionId: third.suggestionId,
      baseRevisionId: changed.revision.id,
    });
    const saved = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    expect(saved.revision.document.machineTranslation?.en).toEqual(['blocks.body.props.content']);
    await expect(
      invoker.run(useCases.publishItem, operator, {
        itemId: created.item.id,
        revisionId: accepted.revisionId,
        locale: 'en',
      })
    ).rejects.toThrow();
    const agent = { ...operator, actor: { kind: 'system' as const, name: 'agent' } };
    await expect(
      invoker.run(useCases.approveTranslation, agent, {
        itemId: created.item.id,
        locale: 'en',
        baseRevisionId: accepted.revisionId,
      })
    ).rejects.toThrow();
    await expect(
      invoker.run(
        useCases.approveTranslation,
        {
          ...operator,
          capabilities: ['content:write'],
        },
        { itemId: created.item.id, locale: 'en', baseRevisionId: accepted.revisionId }
      )
    ).rejects.toThrow();
    const ordinaryDocument = structuredClone(saved.revision.document);
    delete ordinaryDocument.machineTranslation;
    const ordinary = await invoker.run(useCases.updateItem, operator, {
      itemId: created.item.id,
      baseRevisionId: accepted.revisionId,
      document: ordinaryDocument,
    });
    expect(ordinary.revision.document.machineTranslation?.en).toEqual([
      'blocks.body.props.content',
    ]);
    const approved = await invoker.run(useCases.approveTranslation, operator, {
      itemId: created.item.id,
      locale: 'en',
      baseRevisionId: ordinary.revision.id,
    });
    const after = await invoker.run(useCases.getItem, operator, { itemId: created.item.id });
    expect(after.revision.document.machineTranslation?.en).toBeUndefined();
    expect(approved.revisionId).not.toBe(accepted.revisionId);
    expect(readinessIssues(after.revision.document, 'en')).toEqual([]);
    const published = await invoker.run(useCases.publishItem, operator, {
      itemId: created.item.id,
      revisionId: approved.revisionId,
      locale: 'en',
    });
    expect(published.publication.find((state) => state.locale === 'en')?.publishedRevisionId).toBe(
      approved.revisionId
    );
    void uow;
  });
});

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
