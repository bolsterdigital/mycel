// Person erasure in memory (ADR 034): the request, the person phase of apply, and the invariant
// on every write that stores a credit afterwards. The same person is author and photographer in
// nl and en, in a current, a historical and a trashed revision, a pattern, a bulk plan and a
// media item; a second person and another tenant stay as they were. The database conformance
// (packages/db/src/person-erasures.conformance.test.ts) repeats apply, grants, export, restore and
// the race against a concurrent registration over Postgres.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { parseJobPayload } from '../../jobs/types.js';
import { EXAMPLE_PNG } from '../../media/service.js';
import { systemPrincipal } from '../../principal.js';
import {
  FakeClock,
  MemoryBlobStore,
  MemoryUnitOfWork,
  TENANT,
  expectCode,
  principal,
} from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { publishScheduled } from '../service.js';
import {
  creditPersonIds,
  scrubErasedChanges,
  scrubErasedCredits,
  valueAtDiffPath,
} from './erasure.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const UNKNOWN = '01900000-0000-7000-8000-00000000dddd';
const admin = systemPrincipal(TENANT, 'test');
const otherAdmin = systemPrincipal(OTHER, 'test');
const SAM = 'Sam de Vries';
const KIM = 'Kim Bakker';

describe('credit scrub (pure)', () => {
  const A = '01900000-0000-7000-8000-0000000000a1';
  const B = '01900000-0000-7000-8000-0000000000b2';
  const value = {
    blocks: [
      { id: 'x', props: { credit: { work: null, photographer: SAM, photographerPersonId: A } } },
      { id: 'y', props: { credit: { work: null, photographer: KIM, photographerPersonId: B } } },
      { id: 'z', props: { credit: { work: { title: 'W', maker: SAM }, photographer: SAM } } },
    ],
  };

  it('nulls only the name beside a registered id and keeps everything else', () => {
    const out = scrubErasedCredits(value, new Set([A]));
    expect(out.blocks[0]!.props.credit).toEqual({
      work: null,
      photographer: null,
      photographerPersonId: A,
    });
    expect(out.blocks[1]).toBe(value.blocks[1]);
    // A credit without a person id names nobody the register knows (rule 6); work.maker stays.
    expect(out.blocks[2]).toBe(value.blocks[2]);
    expect(creditPersonIds(value)).toEqual(new Set([A, B]));
  });

  it('returns the same reference when nothing changes, and is repeatable', () => {
    expect(scrubErasedCredits(value, new Set())).toBe(value);
    expect(scrubErasedCredits(value, new Set([UNKNOWN]))).toBe(value);
    const once = scrubErasedCredits(value, new Set([A]));
    expect(scrubErasedCredits(once, new Set([A]))).toBe(once);
  });

  it('nulls a plan change at a credit name by the candidate or by a sibling id change', () => {
    const candidate = scrubErasedCredits(value, new Set([A]));
    const path = 'blocks[id=x].props.credit';
    expect(valueAtDiffPath(candidate, path)).toEqual(candidate.blocks[0]!.props.credit);
    const changes = [
      { path: `${path}.photographer`, before: 'Old', after: SAM },
      { path: 'blocks[id=y].props.credit.photographer', before: 'Old', after: KIM },
      { path: 'blocks[id=new]', after: value.blocks[0] },
    ];
    expect(scrubErasedChanges(changes, candidate, new Set([A]))).toEqual([
      { path: `${path}.photographer`, before: null, after: null },
      changes[1],
      { path: 'blocks[id=new]', after: candidate.blocks[0] },
    ]);
    // The candidate names B now, the base named A: the sibling id change finds A.
    const moved = [
      { path: 'blocks[id=y].props.credit.photographer', before: SAM, after: KIM },
      { path: 'blocks[id=y].props.credit.photographerPersonId', before: A, after: B },
    ];
    expect(scrubErasedChanges(moved, candidate, new Set([A]))[0]).toEqual({
      path: 'blocks[id=y].props.credit.photographer',
      before: null,
      after: null,
    });
  });
});

describe('content.person.erase in memory', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let photo = '';
  let sam = '';
  let kim = '';
  let itemId = '';
  let patternId = '';
  let planId = '';
  let trashedId = '';
  let otherSam = '';

  const credit = (personId: string, name: string) => ({
    work: null,
    photographer: name,
    photographerPersonId: personId,
  });
  const image = (id: string, personId: string, name: string, mediaId = photo) => ({
    id,
    type: 'image' as const,
    version: 1 as const,
    props: {
      mediaId,
      decorative: false,
      alt: { nl: 'Een foto', en: 'A photo' },
      credit: credit(personId, name),
    },
  });
  const article = (title: string, blocks: object[], authorIds = [sam]) => ({
    type: 'article' as const,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: `${title} nl`, en: `${title} en` },
    lead: { nl: 'Intro', en: 'Intro' },
    authorIds,
    blocks: blocks as never,
  });
  const latest = async (id = itemId) =>
    (await invoker.run(useCases.getItem, admin, { itemId: id })).revision;
  const save = async (doc: ReturnType<typeof article>, id = itemId, base?: string) =>
    invoker.run(useCases.updateItem, admin, {
      itemId: id,
      baseRevisionId: base ?? (await latest(id)).id,
      document: doc,
    });
  const tenantJson = (tenant = TENANT) => {
    const s = uow.store.for(tenant);
    return JSON.stringify([
      [...s.revisions.values()],
      [...s.patterns.values()],
      [...s.bulkPlans.values()],
      [...s.media.values()].map((m) => m.credit),
      [...s.authors.values()],
    ]);
  };
  const apply = (tenant = TENANT) =>
    uow.run(systemPrincipal(tenant, 'erasures'), (ctx) => ctx.erasures.apply());

  async function person(as: typeof admin, slug: string, name: string) {
    return (
      await invoker.run(useCases.createPerson, as, {
        slug,
        name,
        email: `${slug}@example.org`,
        bio: { nl: `${name} bio`, en: `${name} bio` },
      })
    ).id;
  }

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock, blobs: new MemoryBlobStore(clock) });
    invoker = new Invoker(buildRegistry(), uow);
    photo = (
      await invoker.run(useCases.uploadMedia, admin, {
        filename: 'p.png',
        contentType: 'image/png',
        bytes: EXAMPLE_PNG,
      })
    ).id;
    sam = await person(admin, 'sam', SAM);
    kim = await person(admin, 'kim', KIM);
    await invoker.run(useCases.createPersonGroup, admin, {
      name: { nl: 'Team' },
      personIds: [sam, kim],
    });
    const created = await invoker.run(useCases.createItem, admin, {
      slug: 'story',
      document: article('Story', [image('a1', sam, SAM), image('a2', kim, KIM)], [sam, kim]),
    });
    itemId = created.item.id;
    // A second revision, so the first is history.
    await save(article('Story v2', [image('a1', sam, SAM), image('a2', kim, KIM)], [sam, kim]));
    patternId = (
      await invoker.run(useCases.createPattern, admin, {
        name: { nl: 'Portret' },
        intendedType: 'article',
        blocks: [image('p1', sam, SAM) as never],
      })
    ).id;
    const base = await latest();
    planId = (
      await invoker.run(useCases.createBulk, admin, {
        locale: 'nl',
        items: [
          {
            itemId,
            baseRevisionId: base.id,
            operation: {
              kind: 'save',
              document: article('Bulk', [image('a1', sam, SAM), image('a2', kim, KIM)], [sam, kim]),
            },
          },
        ],
      })
    ).id;
    await invoker.run(useCases.updateMedia, admin, { id: photo, credit: credit(sam, SAM) });
    trashedId = (
      await invoker.run(useCases.createItem, admin, {
        slug: 'old',
        document: article('Old', [image('t1', sam, SAM)]),
      })
    ).item.id;
    await invoker.run(useCases.deleteItem, admin, { itemId: trashedId });
    otherSam = await person(otherAdmin, 'sam', SAM);
  });

  it('refuses an unknown id or another tenant’s person as a whole, and registers nothing', async () => {
    for (const ids of [[UNKNOWN], [sam, UNKNOWN], [otherSam]])
      await expectCode(invoker.run(useCases.erasePeople, admin, { personIds: ids }), 'not_found');
    expect(uow.store.for(TENANT).personErasures.size).toBe(0);
    expect(uow.store.jobs.filter((j) => j.type === 'person.erase')).toEqual([]);
  });

  it('requires supporters:erase and records the erase effect', async () => {
    const editor = principal({ capabilities: ['content:read', 'content:write'] });
    await expectCode(invoker.run(useCases.erasePeople, editor, { personIds: [sam] }), 'forbidden');
    expect(useCases.erasePeople.effect).toBe('erase');
    expect(useCases.erasePeople.requires).toBe('supporters:erase');
  });

  it('registers, plans one job, applies, and a second request is a no-op', async () => {
    const first = await invoker.run(useCases.erasePeople, admin, { personIds: [sam] });
    expect(first.created).toEqual([sam]);
    expect(first.people).toMatchObject([{ personId: sam, applied: false }]);
    expect(first.notErased).toEqual(['text-mentions', 'image-pixels']);
    const jobs = uow.store.jobs.filter((j) => j.type === 'person.erase');
    expect(jobs.map((j) => parseJobPayload('person.erase', j.payload))).toEqual([
      { personIds: [sam] },
    ]);

    expect(tenantJson()).toContain(SAM);
    expect(await apply()).toBeGreaterThan(0);
    const json = tenantJson();
    expect(json).not.toContain(SAM);
    expect(json).not.toContain('sam@example.org');
    // The ids stay as inert references, and nothing of Kim changed.
    expect(json).toContain(sam);
    expect(json).toContain(KIM);
    const s = uow.store.for(TENANT);
    expect(s.authors.has(sam)).toBe(false);
    expect([...s.personGroups.values()][0]!.personIds).toEqual([kim]);
    // The other tenant's person with the same name is untouched.
    expect(tenantJson(OTHER)).toContain(SAM);
    expect(await apply()).toBe(0);

    const again = await invoker.run(useCases.erasePeople, admin, { personIds: [sam] });
    expect(again).toMatchObject({ created: [], people: [{ personId: sam, applied: true }] });
    expect(uow.store.jobs.filter((j) => j.type === 'person.erase')).toHaveLength(1);
    // The slug is free again.
    await expect(person(admin, 'sam', 'Someone else')).resolves.toBeTruthy();
  });

  it('accepts the request while the tenant is suspended; an ordinary write is not', async () => {
    const suspended = principal({ tenantStatus: 'suspended' });
    await expectCode(
      invoker.run(useCases.createPerson, suspended, { slug: 'new', name: 'New' }),
      'suspended'
    );
    const result = await invoker.run(useCases.erasePeople, suspended, { personIds: [sam] });
    expect(result.created).toEqual([sam]);
  });

  describe('after the erasure', () => {
    beforeEach(async () => {
      await invoker.run(useCases.erasePeople, admin, { personIds: [sam] });
      await apply();
    });

    it('saves, publishes and schedules a document that still carries the id, storing no name', async () => {
      // A stale tab sends the old name beside the registered id, on an old base.
      const first = (await invoker.run(useCases.listRevisions, admin, { itemId })).revisions.at(
        -1
      )!;
      const saved = await save(
        article('Story', [image('a1', sam, SAM), image('a2', kim, KIM)], [sam, kim]),
        itemId,
        first.id
      );
      expect(JSON.stringify(saved.revision.document)).not.toContain(SAM);
      expect(JSON.stringify(saved.revision.document)).toContain(KIM);
      expect(saved.revision.document).toMatchObject({ authorIds: [sam, kim] });
      await invoker.run(useCases.publishItem, admin, {
        itemId,
        revisionId: saved.revision.id,
        locale: 'nl',
      });
      const at = new Date(clock.now().getTime() + 60_000).toISOString();
      await invoker.run(useCases.scheduleItem, admin, {
        itemId,
        revisionId: saved.revision.id,
        locale: 'en',
        at,
      });
      clock.advance(60_000);
      const job = uow.store.jobs.find((j) => j.type === 'content.publish' && !j.doneAt)!;
      await uow.run(systemPrincipal(TENANT, 'jobs:content.publish'), (ctx) =>
        publishScheduled(ctx, parseJobPayload('content.publish', job.payload))
      );
      const { item } = await invoker.run(useCases.getItem, admin, { itemId });
      expect(item.publication.find((p) => p.locale === 'en')?.publishedRevisionId).toBe(
        saved.revision.id
      );
    });

    it('still refuses an id that was never registered', async () => {
      await expectCode(save(article('Unknown', [], [UNKNOWN])), 'invalid_input');
      await expectCode(
        save(article('Unknown credit', [image('u1', UNKNOWN, 'Nobody')])),
        'invalid_input'
      );
    });

    it('saves a pattern and freezes a bulk plan with the id, storing no name', async () => {
      const pattern = await invoker.run(useCases.createPattern, admin, {
        name: { nl: 'Nieuw' },
        intendedType: 'article',
        blocks: [image('n1', sam, SAM) as never],
      });
      expect(JSON.stringify(pattern)).not.toContain(SAM);
      const base = await latest();
      const plan = await invoker.run(useCases.createBulk, admin, {
        locale: 'nl',
        items: [
          {
            itemId,
            baseRevisionId: base.id,
            operation: {
              kind: 'save',
              document: article(
                'Bulk after',
                [image('a1', sam, SAM), image('a2', kim, KIM)],
                [sam, kim]
              ),
            },
          },
        ],
      });
      expect(plan.items[0]!.preview.status).toBe('ready');
      expect(JSON.stringify(plan)).not.toContain(SAM);
    });

    it('applies and undoes a bulk plan made before the erasure', async () => {
      const step = { planId, version: 1 as const, ordinal: 0 };
      const applied = await invoker.run(useCases.resumeBulk, admin, step);
      expect(applied.result.status).toBe('changed');
      const undone = await invoker.run(useCases.withdrawBulk, admin, step);
      expect(undone.result.status).toBe('undone');
      expect(tenantJson()).not.toContain(SAM);
    });

    it('stores no name on media.update and refuses the id on a new upload', async () => {
      const updated = await invoker.run(useCases.updateMedia, admin, {
        id: photo,
        credit: credit(sam, SAM),
      });
      expect(updated.credit).toEqual({ work: null, photographer: null, photographerPersonId: sam });
      await expectCode(
        invoker.run(useCases.uploadMedia, admin, {
          filename: 'q.png',
          contentType: 'image/png',
          bytes: EXAMPLE_PNG,
          credit: credit(sam, SAM),
        }),
        'not_found'
      );
      await expectCode(
        invoker.run(useCases.updateMedia, admin, { id: photo, credit: credit(UNKNOWN, 'X') }),
        'not_found'
      );
    });

    it('keeps the trashed item restorable with the id and without the name', async () => {
      await invoker.run(useCases.restoreItem, admin, { itemId: trashedId });
      const revision = await latest(trashedId);
      expect(JSON.stringify(revision)).not.toContain(SAM);
      expect(JSON.stringify(revision)).toContain(sam);
      expect(patternId).toBeTruthy();
    });
  });
});
