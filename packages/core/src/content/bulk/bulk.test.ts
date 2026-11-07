// The dry run is durable data, never an execution. These invariants also cover the ordinary
// save helper shared with it; Postgres adds actual immutability, foreign keys and RLS.
import { describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { anonymousPrincipal } from '../../principal.js';
import { MemoryUnitOfWork, principal, TENANT } from '../../testing/index.js';
import { exampleId } from '../../util/ids.js';
import { Revision } from '../model.js';
import { BulkOperation } from './model.js';
import type { z } from 'zod';

function setup() {
  const uow = new MemoryUnitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = principal();
  const create = () =>
    invoker.run(useCases.createItem, admin, {
      document: {
        type: 'page',
        title: { nl: 'Original' },
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        blocks: [],
      },
    });
  return { uow, invoker, admin, create };
}

describe('content bulk plans', () => {
  it('freezes a candidate and differences without writing a revision, publication or job', async () => {
    const { invoker, admin, create, uow } = setup();
    const original = await create();
    const input = {
      locale: 'nl',
      items: [
        {
          itemId: original.item.id,
          baseRevisionId: original.revision.id,
          operation: {
            kind: 'save' as const,
            document: { ...original.revision.document, title: { nl: 'New' } },
          },
        },
      ],
    };
    const plan = await invoker.run(useCases.createBulk, admin, input);
    expect(plan.items[0]?.preview).toMatchObject({
      status: 'ready',
      changes: [{ path: 'title.nl', before: 'Original', after: 'New' }],
    });
    expect(await invoker.run(useCases.getItem, admin, { itemId: original.item.id })).toMatchObject(
      original
    );
    expect(
      (await invoker.run(useCases.listRevisions, admin, { itemId: original.item.id })).revisions
    ).toHaveLength(1);
    expect(uow.store.jobs).toEqual([]);
    // Both the returned value and the later source content can change without changing a plan.
    const snapshot = structuredClone(plan);
    plan.items[0]!.preview.changes.length = 0;
    await invoker.run(useCases.updateItem, admin, {
      itemId: original.item.id,
      baseRevisionId: original.revision.id,
      document: { ...original.revision.document, title: { nl: 'Later' } },
    });
    expect(await invoker.run(useCases.getBulk, admin, { planId: plan.id })).toEqual(snapshot);
  });

  it('reports write/publish permissions separately and grants no authority from the maker', async () => {
    const { invoker, admin, create } = setup();
    const original = await create();
    const input = {
      locale: 'nl',
      items: [
        {
          itemId: original.item.id,
          baseRevisionId: original.revision.id,
          operation: { kind: 'save' as const, document: original.revision.document, publish: true },
        },
      ],
    };
    const writer = principal({ capabilities: ['content:read', 'content:write'] });
    const plan = await invoker.run(useCases.createBulk, writer, input);
    expect(plan.items[0]?.preview).toMatchObject({
      status: 'refused',
      problems: [{ code: 'forbidden', issues: [{ params: { capability: 'content:publish' } }] }],
    });
    expect((await invoker.run(useCases.createBulk, admin, input)).items[0]?.preview.status).toBe(
      'ready'
    );
    await expect(
      invoker.run(useCases.getBulk, principal({ capabilities: [] }), { planId: plan.id })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      invoker.run(useCases.getBulk, principal({ tenantId: exampleId(999) }), { planId: plan.id })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      invoker.run(useCases.getBulk, anonymousPrincipal(TENANT, ['content:read']), {
        planId: plan.id,
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('distinguishes first publication, unseen drafts, merges, conflicts and untranslated content', async () => {
    const { invoker, admin, create } = setup();
    const first = await create();
    const plan = (
      locale = 'nl',
      op: z.input<typeof BulkOperation> = { kind: 'publish', revisionId: first.revision.id }
    ) =>
      invoker.run(useCases.createBulk, admin, {
        locale,
        items: [{ itemId: first.item.id, baseRevisionId: first.revision.id, operation: op }],
      });
    expect((await plan()).items[0]?.preview.status).toBe('ready');
    expect((await plan('en')).items[0]?.preview).toMatchObject({
      status: 'refused',
      problems: [{ code: 'invalid_input' }],
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: first.item.id,
      locale: 'nl',
      revisionId: first.revision.id,
    });
    const changed = await invoker.run(useCases.updateItem, admin, {
      itemId: first.item.id,
      baseRevisionId: first.revision.id,
      document: { ...first.revision.document, title: { nl: 'Colleague' } },
    });
    const waiting = await invoker.run(useCases.createBulk, admin, {
      locale: 'nl',
      items: [
        {
          itemId: first.item.id,
          baseRevisionId: changed.revision.id,
          operation: { kind: 'publish', revisionId: changed.revision.id },
        },
      ],
    });
    expect(waiting.items[0]?.preview.status).toBe('awaiting_editor');
    const merged = await plan('nl', {
      kind: 'save' as const,
      publish: true,
      document: { ...first.revision.document, lead: { nl: 'My lead' } },
    });
    expect(merged.items[0]?.preview).toMatchObject({
      status: 'awaiting_editor',
      candidate: { title: { nl: 'Colleague' }, lead: { nl: 'My lead' } },
      merge: { latestRevisionId: changed.revision.id },
    });
    const conflict = await plan('nl', {
      kind: 'save' as const,
      document: { ...first.revision.document, title: { nl: 'Mine' } },
    });
    expect(conflict.items[0]?.preview).toMatchObject({
      status: 'refused',
      problems: [
        {
          code: 'conflict',
          issues: expect.arrayContaining([
            { path: 'document.title.nl', message: 'content.revision.conflict-value' },
          ]),
        },
      ],
    });
  });

  it('keeps every selected item, including unknown ids, and bounds and authenticates the input', async () => {
    const { invoker, admin, create } = setup();
    const first = await create();
    const selection = {
      itemId: first.item.id,
      baseRevisionId: first.revision.id,
      operation: { kind: 'unpublish' as const },
    };
    const plan = await invoker.run(useCases.createBulk, admin, {
      locale: 'nl',
      items: [selection, { ...selection, itemId: exampleId(88) }],
    });
    expect(plan.items.map((i) => i.preview.status)).toEqual(['unchanged', 'refused']);
    expect(plan.items[1]).toMatchObject({
      resolvedItemId: null,
      preview: { problems: [{ code: 'not_found' }] },
    });
    for (const items of [
      [],
      [selection, selection],
      Array.from({ length: 101 }, (_, n) => ({ ...selection, itemId: exampleId(n + 100) })),
    ])
      await expect(
        invoker.run(useCases.createBulk, admin, { locale: 'nl', items })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    for (const extra of [{ actor: admin.actor }, { tenantId: TENANT }, { query: '*' }])
      await expect(
        invoker.run(useCases.createBulk, admin, { locale: 'nl', items: [selection], ...extra })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      invoker.run(useCases.createBulk, principal({ tenantStatus: 'suspended' }), {
        locale: 'nl',
        items: [selection],
      })
    ).rejects.toMatchObject({ code: 'suspended' });
  });

  it('reports references and disabled blocks and refuses a publication effect on a schedule', async () => {
    const { invoker, admin, create } = setup();
    const original = await create();
    const selection = { itemId: original.item.id, baseRevisionId: original.revision.id };
    const invalid = await invoker.run(useCases.createBulk, admin, {
      locale: 'nl',
      items: [
        {
          ...selection,
          operation: {
            kind: 'save',
            document: { ...original.revision.document, heroImageId: exampleId(44) },
          },
        },
      ],
    });
    expect(invalid.items[0]?.preview).toMatchObject({
      status: 'refused',
      candidate: null,
      problems: [
        {
          code: 'invalid_input',
          issues: [
            {
              path: 'heroImageId',
              message: 'content.reference.media-unknown',
              params: { id: exampleId(44) },
            },
          ],
        },
      ],
    });
    const limited = principal({
      entitlements: { ...admin.entitlements, blocks: { heading: false } },
    });
    const disabled = await invoker.run(useCases.createBulk, limited, {
      locale: 'nl',
      items: [
        {
          ...selection,
          operation: {
            kind: 'save',
            document: {
              ...original.revision.document,
              blocks: [{ type: 'heading', version: 1, props: { text: { nl: 'Heading' } } }],
            },
          },
        },
      ],
    });
    expect(disabled.items[0]?.preview).toMatchObject({
      status: 'refused',
      problems: [{ code: 'limit_exceeded' }],
    });
    const scheduled = await invoker.run(useCases.scheduleItem, admin, {
      itemId: original.item.id,
      revisionId: original.revision.id,
      locale: 'nl',
      at: '2030-01-01T12:00:00Z',
    });
    const plan = await invoker.run(useCases.createBulk, admin, {
      locale: 'nl',
      items: [{ ...selection, operation: { kind: 'unpublish' } }],
    });
    expect(plan.items[0]?.preview).toMatchObject({
      status: 'refused',
      problems: [
        { code: 'conflict', issues: [{ path: 'publication', message: 'content.bulk.scheduled' }] },
      ],
    });
    expect((await invoker.run(useCases.getItem, admin, { itemId: original.item.id })).item).toEqual(
      scheduled
    );
  });

  it('preserves old provenance and composes a bulk origin with merge or assist origins', async () => {
    const { create } = setup();
    const { revision } = await create();
    const bulk = { runId: exampleId(55), phase: 'apply' };
    const origins = [
      null,
      { merged: { baseRevisionId: revision.id, latestRevisionId: revision.id } },
      { suggestionId: exampleId(66), task: 'alt', provider: 'fake', model: 'fake', edited: false },
    ];
    for (const origin of origins) {
      expect(Revision.parse({ ...revision, provenance: origin }).provenance).toEqual(origin);
      expect(Revision.parse({ ...revision, provenance: { ...origin, bulk } }).provenance).toEqual({
        ...origin,
        bulk,
      });
    }
  });
});
