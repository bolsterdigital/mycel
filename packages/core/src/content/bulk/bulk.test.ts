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

describe('content bulk execution and undo', () => {
  it('reports twenty frozen items, an actual conflict and a saved but unpublished colleague draft', async () => {
    const { invoker, admin, create } = setup();
    const originals = [];
    for (let n = 0; n < 20; n++) originals.push(await create());
    const last = originals[19]!;
    await invoker.run(useCases.publishItem, admin, {
      itemId: last.item.id,
      locale: 'nl',
      revisionId: last.revision.id,
    });
    const colleague = await invoker.run(useCases.updateItem, admin, {
      itemId: last.item.id,
      baseRevisionId: last.revision.id,
      document: { ...last.revision.document, lead: { nl: 'Colleague draft' } },
    });
    const plan = await invoker.run(useCases.createBulk, admin, {
      locale: 'nl',
      items: originals.map((o, n) => ({
        itemId: o.item.id,
        baseRevisionId: n === 19 ? colleague.revision.id : o.revision.id,
        operation: {
          kind: 'save' as const,
          publish: true,
          document: {
            ...(n === 19 ? colleague : o).revision.document,
            title: { nl: 'Bulk title' },
          },
        },
      })),
    });
    const conflict = originals[18]!;
    await invoker.run(useCases.updateItem, admin, {
      itemId: conflict.item.id,
      baseRevisionId: conflict.revision.id,
      document: { ...conflict.revision.document, title: { nl: 'Other title' } },
    });
    for (let ordinal = 0; ordinal < 20; ordinal++) {
      const result = await invoker.run(useCases.resumeBulk, admin, {
        planId: plan.id,
        version: 1,
        ordinal,
      });
      expect(result.next).toBe(ordinal === 19 ? null : ordinal + 1);
    }
    const report = await invoker.run(useCases.checkBulk, admin, { planId: plan.id });
    expect(report.items.map((i) => i.apply?.status)).toEqual([
      ...Array(18).fill('changed'),
      'conflict',
      'awaiting_editor',
    ]);
    expect(report.items[19]?.apply).toMatchObject({
      savedRevisionId: expect.any(String),
      publicationChanged: false,
      publishedRevisionId: null,
    });
    expect(
      (await invoker.run(useCases.getItem, admin, { itemId: last.item.id })).item.publication[0]
        ?.publishedRevisionId
    ).toBe(last.revision.id);
    // Undo is scoped to the whole frozen run, traversed in bounded item transactions.
    const edited = originals[0]!;
    const current = await invoker.run(useCases.getItem, admin, { itemId: edited.item.id });
    await invoker.run(useCases.updateItem, admin, {
      itemId: edited.item.id,
      baseRevisionId: current.revision.id,
      document: { ...current.revision.document, lead: { nl: 'Later work' } },
    });
    for (let ordinal = 0; ordinal < 20; ordinal++)
      await invoker.run(useCases.withdrawBulk, admin, { planId: plan.id, version: 1, ordinal });
    const restored = await invoker.run(useCases.checkBulk, admin, { planId: plan.id });
    expect(restored.fullyUndone).toBe(false);
    expect(restored.items[0]?.undo?.status).toBe('conflict');
    expect(restored.items.slice(1, 18).every((i) => i.undo?.status === 'undone')).toBe(true);
    expect(
      (await invoker.run(useCases.getItem, admin, { itemId: last.item.id })).revision.document
    ).toEqual(colleague.revision.document);
    expect(
      (await invoker.run(useCases.getItem, admin, { itemId: edited.item.id })).revision.document
        .lead
    ).toEqual({ nl: 'Later work' });
  });

  it('never publishes a new or no-op merged draft, and undo preserves the actual pre-mutation revision', async () => {
    const { invoker, admin, create } = setup();
    for (const noop of [false, true]) {
      const original = await create();
      const document = { ...original.revision.document, lead: { nl: 'Bulk lead' } };
      const plan = await invoker.run(useCases.createBulk, admin, {
        locale: 'nl',
        items: [
          {
            itemId: original.item.id,
            baseRevisionId: original.revision.id,
            operation: { kind: 'save', document, publish: true },
          },
        ],
      });
      const colleague = await invoker.run(useCases.updateItem, admin, {
        itemId: original.item.id,
        baseRevisionId: original.revision.id,
        document: noop ? document : { ...original.revision.document, title: { nl: 'Colleague' } },
      });
      const applied = await invoker.run(useCases.resumeBulk, admin, {
        planId: plan.id,
        version: 1,
      });
      expect(applied.result).toMatchObject({
        status: 'awaiting_editor',
        publicationChanged: false,
        merge: { latestRevisionId: colleague.revision.id },
      });
      const undone = await invoker.run(useCases.withdrawBulk, admin, {
        planId: plan.id,
        version: 1,
      });
      expect(undone.result.status).toBe(noop ? 'unchanged' : 'undone');
      expect(
        (await invoker.run(useCases.getItem, admin, { itemId: original.item.id })).revision.document
      ).toEqual(colleague.revision.document);
    }
  });

  it('serialises two executors and retries, restores once, and refuses apply after undo was requested', async () => {
    const { invoker, admin, create } = setup();
    const o = await create();
    const plan = await invoker.run(useCases.createBulk, admin, {
      locale: 'nl',
      items: [
        {
          itemId: o.item.id,
          baseRevisionId: o.revision.id,
          operation: {
            kind: 'save',
            document: { ...o.revision.document, title: { nl: 'Changed' } },
            publish: true,
          },
        },
      ],
    });
    const input = { planId: plan.id, version: 1 as const };
    const [a, b] = await Promise.all([
      invoker.run(useCases.resumeBulk, admin, input),
      invoker.run(useCases.resumeBulk, admin, input),
    ]);
    expect(a).toEqual(b);
    expect(
      (await invoker.run(useCases.listRevisions, admin, { itemId: o.item.id })).revisions
    ).toHaveLength(2);
    const [x, y] = await Promise.all([
      invoker.run(useCases.withdrawBulk, admin, input),
      invoker.run(useCases.withdrawBulk, admin, input),
    ]);
    expect(x).toEqual(y);
    expect(
      (await invoker.run(useCases.listRevisions, admin, { itemId: o.item.id })).revisions
    ).toHaveLength(3);
    expect((await invoker.run(useCases.checkBulk, admin, { planId: plan.id })).fullyUndone).toBe(
      true
    );
    expect(
      (await invoker.run(useCases.getItem, admin, { itemId: o.item.id })).item.publication[0]
        ?.publishedRevisionId
    ).toBeNull();
    await expect(invoker.run(useCases.resumeBulk, admin, input)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('uses current capabilities for all effects before changing anything, not maker grants or forged input', async () => {
    const { invoker, admin, create } = setup();
    const o = await create();
    const plan = await invoker.run(useCases.createBulk, admin, {
      locale: 'nl',
      items: [
        {
          itemId: o.item.id,
          baseRevisionId: o.revision.id,
          operation: {
            kind: 'save',
            document: { ...o.revision.document, title: { nl: 'Changed' } },
            publish: true,
          },
        },
      ],
    });
    const input = { planId: plan.id, version: 1 as const };
    const writer = principal({ capabilities: ['content:read', 'content:write'] });
    expect((await invoker.run(useCases.resumeBulk, writer, input)).result).toMatchObject({
      status: 'refused',
      retryable: true,
    });
    expect((await invoker.run(useCases.getItem, admin, { itemId: o.item.id })).revision.id).toBe(
      o.revision.id
    );
    await invoker.run(useCases.resumeBulk, admin, input);
    expect((await invoker.run(useCases.withdrawBulk, writer, input)).result.status).toBe('refused');
    expect(
      (await invoker.run(useCases.getItem, admin, { itemId: o.item.id })).revision.document.title.nl
    ).toBe('Changed');
    expect((await invoker.run(useCases.withdrawBulk, admin, input)).result.status).toBe('undone');
    for (const uc of [useCases.resumeBulk, useCases.withdrawBulk]) {
      await expect(
        invoker.run(uc, principal({ tenantId: exampleId(500) }), input)
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        invoker.call(admin, uc.name, { ...input, actor: admin.actor })
      ).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(
        invoker.run(uc, principal({ tenantStatus: 'suspended' }), input)
      ).rejects.toMatchObject({ code: 'suspended' });
    }
  });

  it('holds changed publication and planning offline and refuses undo after later publication', async () => {
    const { invoker, admin, create } = setup();
    const o = await create();
    const plan = await invoker.run(useCases.createBulk, admin, {
      locale: 'nl',
      items: [
        {
          itemId: o.item.id,
          baseRevisionId: o.revision.id,
          operation: {
            kind: 'save',
            document: { ...o.revision.document, lead: { nl: 'Lead' } },
            publish: true,
          },
        },
      ],
    });
    await invoker.run(useCases.scheduleItem, admin, {
      itemId: o.item.id,
      revisionId: o.revision.id,
      locale: 'nl',
      at: '2030-01-01T12:00:00Z',
    });
    const input = { planId: plan.id, version: 1 as const };
    expect((await invoker.run(useCases.resumeBulk, admin, input)).result.status).toBe(
      'awaiting_editor'
    );
    const current = await invoker.run(useCases.getItem, admin, { itemId: o.item.id });
    expect(current.item.publication[0]?.scheduledRevisionId).toBe(o.revision.id);
    await invoker.run(useCases.publishItem, admin, {
      itemId: o.item.id,
      locale: 'nl',
      revisionId: current.revision.id,
    });
    expect((await invoker.run(useCases.withdrawBulk, admin, input)).result.status).toBe('conflict');
  });
});
