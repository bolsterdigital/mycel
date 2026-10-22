// The #8b2 blocks against Postgres (TODO #8b2): what memory cannot prove. Image, hero and form
// references land in `content_block_refs` and `media_usages` in the save's transaction; `find`
// follows the publication pointers for media; another tenant's, a deleted and a PDF media id are
// refused; patterns keep usages under `pattern:<id>`; historical revisions keep theirs; a usage
// write that falls short rolls back the whole save (document, block operation and pattern); and
// save and delete serialise on the media lock in both orders. Two tenants, the application role,
// no migration. Skips without DATABASE_URL and APP_DATABASE_URL; with E2E_REQUIRED=1 (CI) that
// is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXAMPLE_PNG,
  Invoker,
  UseCaseError,
  buildRegistry,
  documentReferences,
  systemPrincipal,
  useCases,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  memoryImageProcessor,
  memoryPlatform,
  overrideMedia,
  pauseMedia,
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

describe.skipIf(!operatorUrl || !appUrl)('content blocks conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const clock = new FakeClock(new Date());
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    media: { blobs: new MemoryBlobStore(clock), images: memoryImageProcessor },
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const via = (u: UnitOfWork) => new Invoker(buildRegistry(), u);
  let tenantA = '';
  let tenantB = '';
  const formA = uuidv7();
  const a = (): Principal => systemPrincipal(tenantA, 'test');
  const b = (): Principal => systemPrincipal(tenantB, 'test');
  let slugs = 0;

  const upload = async (p: Principal, pdf = false) =>
    (
      await invoker.run(useCases.uploadMedia, p, {
        filename: pdf ? 'r.pdf' : 'p.png',
        contentType: pdf ? 'application/pdf' : 'image/png',
        bytes: pdf ? Buffer.from('%PDF-1.7\n').toString('base64') : EXAMPLE_PNG,
      })
    ).id;
  const image = (id: string, mediaId: string) => ({
    id,
    type: 'image' as const,
    version: 1 as const,
    props: { mediaId, decorative: false, alt: { nl: 'Foto' } },
  });
  const hero = (id: string, mediaId: string, itemId: string) => ({
    id,
    type: 'hero' as const,
    version: 1 as const,
    props: {
      variant: 'cover' as const,
      title: { nl: 'Kop' },
      image: { mediaId, decorative: true, alt: null },
      actions: [{ label: { nl: 'Lees' }, target: { kind: 'item' as const, itemId } }],
    },
  });
  const form = (id: string, formId: string) => ({
    id,
    type: 'form' as const,
    version: 1 as const,
    props: { formId, variant: 'card' as const },
  });
  const heading = (id: string) => ({
    id,
    type: 'heading' as const,
    version: 1 as const,
    props: { text: { nl: id } },
  });
  const page = (blocks: object[], p = a(), inv = invoker) =>
    inv.run(useCases.createItem, p, {
      slug: `blocks-${run}-${++slugs}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Titel' },
        blocks: blocks as never,
      },
    });
  const pattern = (blocks: object[], p = a(), inv = invoker) =>
    inv.run(useCases.createPattern, p, {
      name: { nl: 'Patroon' },
      intendedType: 'page',
      blocks: blocks as never,
    });

  /** Usages of a media id as mycel_app sees them under `p`'s tenant, `ref block` sorted. */
  const usagesOf = (mediaId: string, p = a()) =>
    withTenant(appDb, p, (trx) =>
      trx
        .selectFrom('media_usages')
        .select(['ref', 'block_id'])
        .where('media_id', '=', mediaId)
        .execute()
    ).then((rows) => rows.map((r) => `${r.ref} ${r.block_id}`).sort());
  const count = (
    table: 'content_items' | 'content_revisions' | 'content_block_refs' | 'patterns'
  ) =>
    withTenant(appDb, a(), (trx) =>
      trx
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).then((r) => Number(r.n));
  const refused = (p: Promise<unknown>, message: string) =>
    expect(p).rejects.toSatisfy(
      (e) =>
        e instanceof UseCaseError &&
        e.code === 'invalid_input' &&
        e.issues.some((i) => i.message.startsWith(message))
    );

  beforeAll(async () => {
    await migrate(operatorUrl!, {
      appPassword: process.env['MYCEL_APP_PASSWORD'],
      authPassword: process.env['MYCEL_AUTH_PASSWORD'],
      log: () => {},
    });
    const tenant = (slug: string) =>
      upsertTenant(
        operatorDb,
        { id: uuidv7(), slug: `${slug}-${run}`, name: slug, defaultLocale: 'nl', locales: ['nl'] },
        { platformDomain: 'localhost' }
      ).then((t) => t.id);
    [tenantA, tenantB] = [await tenant('blocks-a'), await tenant('blocks-b')];
    await uow.run(a(), (ctx) => ctx.forms.insert(probeForm(formA)));
  });

  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('writes refs and usages of image, hero and form blocks in the save', async () => {
    const photo = await upload(a());
    const target = (await page([heading('t')])).item.id;
    const { item, revision } = await page([
      image('img', photo),
      hero('hero', photo, target),
      form('f', formA),
    ]);
    const rows = await withTenant(appDb, a(), (trx) =>
      trx
        .selectFrom('content_block_refs')
        .select(['block_id', 'type', 'ref_id'])
        .where('revision_id', '=', revision.id)
        .execute()
    );
    const key = (r: { block_id: string | null; type: string; ref_id: string }) =>
      `${r.block_id} ${r.type} ${r.ref_id}`;
    expect(rows.map(key).sort()).toEqual(
      documentReferences(revision.document)
        .map((r) => key({ block_id: r.blockId, type: r.type, ref_id: r.refId }))
        .sort()
    );
    expect(rows.map(key).sort()).toEqual(
      [`f form ${formA}`, `hero item ${target}`, `hero media ${photo}`, `img media ${photo}`].sort()
    );
    const ref = `item:${item.id}:rev:${revision.id}`;
    expect(await usagesOf(photo)).toEqual([`${ref} hero`, `${ref} img`]);
  });

  it('finds media in the latest revision or, with live, only in what a locale publishes', async () => {
    const photo = await upload(a());
    const { item, revision } = await page([heading('h')]);
    await invoker.run(useCases.publishItem, a(), {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    const draft = await invoker.run(useCases.insertBlock, a(), {
      itemId: item.id,
      baseRevisionId: revision.id,
      block: image('img', photo),
      place: { at: 'end' },
    });
    const find = (live: boolean) =>
      invoker
        .run(useCases.findItems, a(), { ref: { type: 'media', id: photo }, live })
        .then((r) => r.matches);
    expect(await find(false)).toEqual([{ itemId: item.id, blockIds: ['img'] }]);
    expect(await find(true)).toEqual([]);
    const typed = await invoker.run(useCases.findItems, a(), { blockType: 'image', live: true });
    expect(typed.matches.map((m) => m.itemId)).not.toContain(item.id);
    await invoker.run(useCases.publishItem, a(), {
      itemId: item.id,
      revisionId: draft.revision.id,
      locale: 'nl',
    });
    expect(await find(true)).toEqual([{ itemId: item.id, blockIds: ['img'] }]);
    // Tenant B sees none of it.
    const other = await invoker.run(useCases.findItems, b(), { ref: { type: 'media', id: photo } });
    expect(other.matches).toEqual([]);
  });

  it("refuses another tenant's, a deleted and a PDF media id, writing nothing", async () => {
    const before = await count('content_revisions');
    const foreign = await upload(b());
    const pdf = await upload(a(), true);
    const gone = await upload(a());
    await invoker.run(useCases.deleteMedia, a(), { id: gone });
    await refused(page([image('i', foreign)]), `content.reference.media-unknown:${foreign}`);
    await refused(page([image('i', gone)]), `content.reference.media-unknown:${gone}`);
    await refused(page([image('i', pdf)]), `content.reference.media-not-image:${pdf}`);
    await refused(pattern([image('i', foreign)]), 'content.reference.media-unknown');
    expect(await count('content_revisions')).toBe(before);
    expect(await usagesOf(foreign, b())).toEqual([]);
  });

  it('keeps usages of older revisions and of patterns; delete refuses until none is left', async () => {
    const photo = await upload(a());
    const { item, revision } = await page([image('img', photo), heading('h')]);
    await invoker.run(useCases.removeBlock, a(), {
      itemId: item.id,
      baseRevisionId: revision.id,
      blockId: 'img',
    });
    expect(await usagesOf(photo)).toEqual([`item:${item.id}:rev:${revision.id} img`]);
    await expect(invoker.run(useCases.deleteMedia, a(), { id: photo })).rejects.toMatchObject({
      code: 'conflict',
    });

    const other = await upload(a());
    const p1 = await pattern([image('one', other)]);
    const p2 = await pattern([image('two', other)]);
    expect(await usagesOf(other)).toEqual([`pattern:${p1.id} one`, `pattern:${p2.id} two`].sort());
    const copy = await invoker.run(useCases.createItem, a(), {
      slug: `from-pattern-${run}`,
      patternId: p1.id,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'K' },
        blocks: [],
      },
    });
    const copiedId = copy.revision.document.blocks[0]!.id;
    expect(copiedId).not.toBe('one');
    for (const patternId of [p1.id, p2.id])
      await invoker.run(useCases.updatePattern, a(), {
        patternId,
        name: { nl: 'Leeg' },
        intendedType: 'page',
        blocks: [],
      });
    // The patterns let go; the copy's revision still holds the image.
    expect(await usagesOf(other)).toEqual([
      `item:${copy.item.id}:rev:${copy.revision.id} ${copiedId}`,
    ]);
  });

  it('rolls back a save, a block operation and a pattern update whose usage write falls short', async () => {
    const photo = await upload(a());
    const short = via(
      overrideMedia(uow, (media) => ({
        replaceUsages: async (ref, list) => {
          const n = await media.replaceUsages(ref, list);
          return list.length ? n - 1 : n;
        },
      }))
    );
    const counts = async () =>
      Promise.all([
        count('content_items'),
        count('content_revisions'),
        count('content_block_refs'),
        count('patterns'),
      ]);

    const before = await counts();
    await refused(page([image('img', photo)], a(), short), 'content.reference.media-unrecorded');
    expect(await counts()).toEqual(before);
    expect(await usagesOf(photo)).toEqual([]);

    const { item, revision } = await page([heading('h')]);
    const afterPage = await counts();
    await refused(
      short.run(useCases.insertBlock, a(), {
        itemId: item.id,
        baseRevisionId: revision.id,
        block: image('img', photo),
        place: { at: 'end' },
      }),
      'content.reference.media-unrecorded'
    );
    expect(await counts()).toEqual(afterPage);
    expect((await invoker.run(useCases.getItem, a(), { itemId: item.id })).revision.id).toBe(
      revision.id
    );

    const p = await pattern([heading('h')]);
    await refused(
      short.run(useCases.updatePattern, a(), {
        patternId: p.id,
        name: { nl: 'Met foto' },
        intendedType: 'page',
        blocks: [image('img', photo)] as never,
      }),
      'content.reference.media-unrecorded'
    );
    const kept = await invoker.run(useCases.getPattern, a(), { patternId: p.id });
    expect(kept.name).toEqual({ nl: 'Patroon' });
    expect(await usagesOf(photo)).toEqual([]);
  });

  it('save first: a concurrent delete waits on the media lock and then refuses', async () => {
    const photo = await upload(a());
    const paused = pauseMedia(uow, 'replaceUsages');
    const save = page([image('img', photo)], a(), via(paused.uow));
    await paused.reached;
    const del = invoker.run(useCases.deleteMedia, a(), { id: photo });
    // Give the delete time to reach the lock; it must still be waiting.
    let settled = false;
    void del.then(
      () => (settled = true),
      () => (settled = true)
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);
    paused.release();
    const saved = await save;
    await expect(del).rejects.toMatchObject({ code: 'conflict' });
    expect(await usagesOf(photo)).toEqual([`item:${saved.item.id}:rev:${saved.revision.id} img`]);
  });

  it('delete first: a concurrent save waits, then refuses with nothing written', async () => {
    const photo = await upload(a());
    const before = await count('content_revisions');
    const paused = pauseMedia(uow, 'softDelete');
    const del = via(paused.uow).run(useCases.deleteMedia, a(), { id: photo });
    await paused.reached;
    const save = page([image('img', photo)]);
    let settled = false;
    void save.then(
      () => (settled = true),
      () => (settled = true)
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);
    paused.release();
    await expect(del).resolves.toMatchObject({ id: photo });
    await refused(save, `content.reference.media-unknown:${photo}`);
    expect(await count('content_revisions')).toBe(before);
    expect(await usagesOf(photo)).toEqual([]);
  });
});
