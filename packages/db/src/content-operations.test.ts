// Block operations, `content_block_refs` and `content.item.find` against Postgres (TODO #8b1,
// migration 0017): what memory cannot prove. Eight operations on one base end in exactly one
// revision through the item lock; after every save the refs table holds exactly the references
// of that revision and nothing for another tenant; the rows are immutable for mycel_app; and
// find and liveReferences follow the publication pointers in SQL. Skips without DATABASE_URL and
// APP_DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
  documentReferences,
  systemPrincipal,
  useCases,
  type Principal,
  type Revision,
} from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  probeForm,
} from '@mycel/core/testing';
import {
  createDb,
  createUnitOfWork,
  migrate,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
  withTenant,
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

describe.skipIf(!operatorUrl || !appUrl)('content operations conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const uow = createUnitOfWork(appDb, {
    clock: new FakeClock(),
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  let tenantA = '';
  let tenantB = '';
  const formA = uuidv7();
  const formB = uuidv7();
  const a = (): Principal => systemPrincipal(tenantA, 'test');
  const b = (): Principal => systemPrincipal(tenantB, 'test');

  const para = (text: string, itemId?: string) => ({
    type: 'paragraph' as const,
    content: [
      {
        type: 'text' as const,
        text,
        ...(itemId ? { marks: [{ type: 'link' as const, attrs: { itemId } }] } : {}),
      },
    ],
  });
  const richText = (id: string, ...content: ReturnType<typeof para>[]) => ({
    id,
    type: 'rich-text' as const,
    version: 1 as const,
    props: { content: { nl: { type: 'doc' as const, content } } },
  });
  const signup = (id: string, formId: string) => ({
    id,
    type: 'signup-form' as const,
    version: 1 as const,
    props: { formId },
  });
  const heading = (id: string) => ({
    id,
    type: 'heading' as const,
    version: 1 as const,
    props: { text: { nl: id } },
  });
  const page = (slug: string, blocks: object[], p = a()) =>
    invoker.run(useCases.createItem, p, {
      slug: `${slug}-${run}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: slug },
        blocks,
      } as never,
    });

  /** The refs rows of one revision as mycel_app sees them under `p`'s tenant. */
  const refsOf = (revisionId: string, p = a()) =>
    withTenant(appDb, p, (trx) =>
      trx
        .selectFrom('content_block_refs')
        .select(['tenant_id', 'item_id', 'block_id', 'type', 'ref_id'])
        .where('revision_id', '=', revisionId)
        .execute()
    );
  const expected = (r: Revision, tenantId = tenantA) =>
    documentReferences(r.document)
      .map((x) => ({
        tenant_id: tenantId,
        item_id: r.itemId,
        block_id: x.blockId,
        type: x.type,
        ref_id: x.refId,
      }))
      .sort(byRow);
  const byRow = (x: { type: string; ref_id: string; block_id: string | null }, y: typeof x) =>
    `${x.type}${x.ref_id}${x.block_id}`.localeCompare(`${y.type}${y.ref_id}${y.block_id}`);

  beforeAll(async () => {
    await migrate(operatorUrl!, { log: () => {} });
    const tenant = (slug: string) =>
      upsertTenant(
        operatorDb,
        { id: uuidv7(), slug, name: slug, defaultLocale: 'nl', locales: ['nl'] },
        { platformDomain: 'localhost' }
      );
    tenantA = (await tenant(`op-a-${run}`)).id;
    tenantB = (await tenant(`op-b-${run}`)).id;
    await uow.run(a(), (ctx) => ctx.forms.insert(probeForm(formA)));
    await uow.run(b(), (ctx) => ctx.forms.insert(probeForm(formB)));
  });

  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('preserves pending locales across transactional split/save/remove and refuses stale or cross-tenant approval', async () => {
    const created = await invoker.run(useCases.createItem, a(), {
      slug: `pending-ops-${run}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Pending' },
        blocks: [richText('body', para('One'), para('Two'))],
        machineTranslation: { nl: ['blocks.body.props.content'] },
      },
    });
    const target = { itemId: created.item.id };
    const human = {
      ...a(),
      actor: { kind: 'operator' as const, operatorId: uuidv7(), email: 'reviewer@probe.test' },
    };
    const split = await invoker.run(useCases.splitInsertBlock, a(), {
      ...target,
      baseRevisionId: created.revision.id,
      blockId: 'body',
      at: { nl: 1 },
      block: heading('separator'),
    });
    const saved = await invoker.run(useCases.updateItem, a(), {
      ...target,
      baseRevisionId: split.revision.id,
      document: { ...split.revision.document, machineTranslation: {} },
    });
    const removed = await invoker.run(useCases.removeBlock, a(), {
      ...target,
      baseRevisionId: saved.revision.id,
      blockId: 'body',
    });
    expect(removed.revision.document.machineTranslation).toEqual({ nl: ['locales'] });
    expect(JSON.stringify(removed.revision.document.blocks)).toContain('Two');
    expect(removed.item.publication).toEqual(created.item.publication);
    for (const p of [human, { ...human, tenantId: tenantB }]) {
      await expect(
        invoker.run(useCases.approveTranslation, p, {
          ...target,
          baseRevisionId: saved.revision.id,
          locale: 'nl',
        })
      ).rejects.toMatchObject({ code: p.tenantId === tenantA ? 'conflict' : 'not_found' });
    }
    await expect(
      invoker.run(useCases.getItem, b(), { ...target, revisionId: removed.revision.id })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      invoker.run(useCases.updateItem, b(), {
        ...target,
        baseRevisionId: removed.revision.id,
        document: removed.revision.document,
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    const revisions = await invoker.run(useCases.listRevisions, a(), target);
    expect(revisions.revisions).toHaveLength(4);
    expect(await invoker.run(useCases.getItem, a(), target)).toEqual({
      item: removed.item,
      revision: removed.revision,
    });
    const outcomes = await Promise.allSettled([
      invoker.run(useCases.approveTranslation, human, {
        ...target,
        baseRevisionId: removed.revision.id,
        locale: 'nl',
      }),
      invoker.run(useCases.updateItem, a(), {
        ...target,
        baseRevisionId: removed.revision.id,
        document: removed.revision.document,
      }),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    });
    expect((await invoker.run(useCases.listRevisions, a(), target)).revisions).toHaveLength(5);
    const latest = await invoker.run(useCases.getItem, a(), target);
    if (outcomes[0]!.status === 'fulfilled')
      expect(latest.revision.document.machineTranslation).toBeUndefined();
    else expect(latest.revision.document.machineTranslation).toEqual({ nl: ['locales'] });
    expect(latest.item.publication).toEqual(created.item.publication);
  });

  it('lets exactly one of eight concurrent operations on one base win, refs included', async () => {
    for (let round = 0; round < 3; round++) {
      const { item, revision } = await page(`race-op-${round}`, [
        richText('t', para('een'), para('twee')),
        signup('f', formA),
        heading('h'),
      ]);
      const base = { itemId: item.id, baseRevisionId: revision.id };
      const ops = [
        () => invoker.run(useCases.removeBlock, a(), { ...base, blockId: 'h' }),
        () =>
          invoker.run(useCases.moveBlock, a(), { ...base, blockId: 'h', place: { at: 'start' } }),
        () =>
          invoker.run(useCases.insertBlock, a(), {
            ...base,
            block: heading('new'),
            place: { after: 'f' },
          }),
        () =>
          invoker.run(useCases.setBlockProps, a(), {
            ...base,
            blockId: 'h',
            props: { text: { nl: 'anders' } },
          }),
        () =>
          invoker.run(useCases.splitInsertBlock, a(), {
            ...base,
            blockId: 't',
            at: { nl: 1 },
            block: signup('split', formA),
          }),
      ];
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => ops[i % ops.length]!())
      );
      const won = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
        revision: Revision;
      }>[];
      const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      for (const l of lost) expect(l.reason).toMatchObject({ code: 'conflict' });
      const { revisions } = await invoker.run(useCases.listRevisions, a(), { itemId: item.id });
      expect(revisions.map((r) => r.id)).toEqual([won[0]!.value.revision.id, revision.id]);
      // The losers left no refs behind: only the two revisions have rows.
      const rows = await withTenant(appDb, a(), (trx) =>
        trx
          .selectFrom('content_block_refs')
          .select('revision_id')
          .distinct()
          .where('item_id', '=', item.id)
          .execute()
      );
      expect(rows.map((r) => r.revision_id).sort()).toEqual(
        [won[0]!.value.revision.id, revision.id].sort()
      );
    }
  });

  it('holds exactly the references of each revision after every save, per tenant', async () => {
    const target = await page('ref-target', []);
    const author = await invoker.run(useCases.createAuthor, a(), {
      slug: `ann-${run}`,
      name: 'Ann',
    });
    const section = await invoker.run(useCases.createSection, a(), {
      slug: `bin-${run}`,
      title: { nl: 'Binnenland' },
    });
    const created = await invoker.run(useCases.createItem, a(), {
      slug: `ref-story-${run}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Verhaal' },
        blocks: [
          // The same item twice in one block is one row.
          richText('t', para('zie', target.item.id), para('en nog eens', target.item.id)),
          signup('f', formA),
        ],
        authorIds: [author.id],
        sectionId: section.id,
      },
    });
    let revision = created.revision;
    expect(await refsOf(revision.id).then((r) => r.sort(byRow))).toEqual(expected(revision));
    expect(await refsOf(revision.id).then((r) => r.length)).toBe(4);

    const steps = [
      (base: string) =>
        invoker.run(useCases.removeBlock, a(), {
          itemId: created.item.id,
          baseRevisionId: base,
          blockId: 'f',
        }),
      (base: string) =>
        invoker.run(useCases.splitInsertBlock, a(), {
          itemId: created.item.id,
          baseRevisionId: base,
          blockId: 't',
          at: { nl: 1 },
          block: signup('g', formA),
        }),
      (base: string) =>
        invoker.run(useCases.setBlockProps, a(), {
          itemId: created.item.id,
          baseRevisionId: base,
          blockId: 't',
          props: { content: { nl: { type: 'doc', content: [para('geen link meer')] } } },
        }),
    ];
    for (const step of steps) {
      revision = (await step(revision.id)).revision;
      expect(await refsOf(revision.id).then((r) => r.sort(byRow))).toEqual(expected(revision));
    }
    // The last revision still links the item from the split-off second part.
    expect(
      (await refsOf(revision.id)).filter((r) => r.type === 'item').map((r) => r.block_id)
    ).toHaveLength(1);
    // Tenant B sees none of A's rows, and its own page gets rows under its own tenant only.
    expect(await refsOf(revision.id, b())).toEqual([]);
    const other = await page('ref-b', [signup('f', formB)], b());
    expect(await refsOf(other.revision.id, b())).toEqual(expected(other.revision, tenantB));
    expect(await refsOf(other.revision.id)).toEqual([]);
  });

  it('keeps refs immutable for mycel_app', async () => {
    const { revision } = await page('ref-immutable', [signup('f', formA)]);
    const state = (q: Parameters<typeof withTenant>[2]) =>
      withTenant(appDb, a(), q).then(
        () => 'ok',
        (e: { code?: string }) => e.code
      );
    expect(
      await state((trx) =>
        sql`update content_block_refs set ref_id = ${formB} where revision_id = ${revision.id}`.execute(
          trx
        )
      )
    ).toBe('42501');
    expect(
      await state((trx) =>
        sql`delete from content_block_refs where revision_id = ${revision.id}`.execute(trx)
      )
    ).toBe('42501');
  });

  it.each(['heading', 'reference'] as const)(
    'returns block ids only from revisions matching both filters (%s only in other locale)',
    async (partial) => {
      const first = await invoker.run(useCases.createItem, a(), {
        slug: `find-locales-${partial}-${run}`,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: 'Titel', en: 'Title' },
          blocks: [
            { ...heading('match-heading'), props: { text: { nl: 'Kop', en: 'Heading' } } },
            signup('match-form', formA),
          ],
        },
      });
      await invoker.run(useCases.publishItem, a(), {
        itemId: first.item.id,
        revisionId: first.revision.id,
        locale: 'nl',
      });
      const second = await invoker.run(useCases.updateItem, a(), {
        itemId: first.item.id,
        baseRevisionId: first.revision.id,
        document: {
          ...first.revision.document,
          blocks:
            partial === 'heading'
              ? [{ ...heading('other-heading'), props: { text: { nl: 'Kop', en: 'Heading' } } }]
              : [signup('other-form', formA)],
        },
      });
      await invoker.run(useCases.publishItem, a(), {
        itemId: first.item.id,
        revisionId: second.revision.id,
        locale: 'en',
      });
      const found = await invoker.run(useCases.findItems, a(), {
        blockType: 'heading',
        ref: { type: 'form', id: formA },
        live: true,
      });
      expect(found.matches.find((m) => m.itemId === first.item.id)?.blockIds.sort()).toEqual([
        'match-form',
        'match-heading',
      ]);
    }
  );

  it('finds draft and live use apart, and counts live references', async () => {
    // Live without the form, draft with it.
    const draftOnly = await page('find-draft', [heading('h')]);
    await invoker.run(useCases.publishItem, a(), {
      itemId: draftOnly.item.id,
      revisionId: draftOnly.revision.id,
      locale: 'nl',
    });
    await invoker.run(useCases.insertBlock, a(), {
      itemId: draftOnly.item.id,
      baseRevisionId: draftOnly.revision.id,
      block: signup('f', formA),
      place: { at: 'end' },
    });
    // Live with the form, draft without it.
    const liveOnly = await page('find-live', [signup('f', formA)]);
    await invoker.run(useCases.publishItem, a(), {
      itemId: liveOnly.item.id,
      revisionId: liveOnly.revision.id,
      locale: 'nl',
    });
    await invoker.run(useCases.removeBlock, a(), {
      itemId: liveOnly.item.id,
      baseRevisionId: liveOnly.revision.id,
      blockId: 'f',
    });
    const mine = [draftOnly.item.id, liveOnly.item.id];
    const found = async (input: object) =>
      (await invoker.run(useCases.findItems, a(), { limit: 100, ...input } as never)).matches
        .filter((m) => mine.includes(m.itemId))
        .map((m) => [m.itemId, m.blockIds]);
    const ref = { type: 'form', id: formA };
    expect(await found({ ref })).toEqual([[draftOnly.item.id, ['f']]]);
    expect(await found({ ref, live: true })).toEqual([[liveOnly.item.id, ['f']]]);
    expect(await found({ blockType: 'signup-form' })).toEqual([[draftOnly.item.id, ['f']]]);
    expect(await found({ blockType: 'signup-form', live: true })).toEqual([
      [liveOnly.item.id, ['f']],
    ]);
    // Another tenant's form id finds nothing here, and B cannot find A's use of A's form.
    expect(await found({ ref: { type: 'form', id: formB } })).toEqual([]);
    expect(
      (await invoker.run(useCases.findItems, b(), { ref: { type: 'form', id: formA } })).items
    ).toEqual([]);

    const live = (p: Principal, id: string) =>
      uow.run(p, (ctx) => ctx.content.liveReferences({ type: 'form', id }));
    const before = await live(a(), formA);
    expect(before).toBeGreaterThanOrEqual(1);
    await invoker.run(useCases.unpublishItem, a(), { itemId: liveOnly.item.id, locale: 'nl' });
    expect(await live(a(), formA)).toBe(before - 1);
    expect(await live(b(), formA)).toBe(0);
  });
});
