// The recording on a card (MY-304) in memory: a Video/audio article's card carries its video's
// length in an overview, "Read more", a dossier box and on an author's page; the profile's hidden
// duration gives a mark without a length; a Post with a video, a trashed video and a restricted
// article's teaser card give none. The rendered mark is apps/web (`ArticleCard`).

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { exampleId } from '../../util/ids.js';

const HOUR = 60 * 60 * 1000;

describe('the recording on a card (MY-304)', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  const admin = systemPrincipal(TENANT, 'test');
  const visitor = anonymousPrincipal(TENANT, ['content:read']);

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
  });

  /** A video of `seconds` in this tenant's library. */
  function video(n: number, seconds: number | null) {
    const id = exampleId(0xf100 + n);
    uow.store.for(TENANT).videos.set(id, {
      id,
      posterId: exampleId(0xf200 + n),
      metadata: { title: { nl: `Video ${n}` } } as never,
      durationSeconds: seconds,
      hasSource: true,
      publishedTracks: {},
      createdAt: clock.now(),
      trashedAt: null,
    });
    return id;
  }

  async function article(slug: string, over: Record<string, unknown> = {}) {
    clock.advance(HOUR);
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: slug },
        blocks: [],
        ...over,
      } as never,
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    return item.id;
  }
  const recording = (videoId: string, presentation: unknown = { profile: 'media' }) => ({
    presentation,
    blocks: [{ type: 'video', version: 1, props: { videoId } }],
  });

  it('shows the length wherever the card stands, and a mark alone when the profile hides it', async () => {
    const person = await invoker.run(useCases.createPerson, admin, {
      slug: 'maker',
      name: 'Maker',
    });
    await article('aflevering', { ...recording(video(1, 754)), authorIds: [person.id] });
    await article('stil', {
      ...recording(video(2, 300), {
        profile: 'media',
        overrides: { media: { readingTime: 'hide' } },
      }),
    });
    await article('post', recording(video(3, 60), { profile: 'post' }));
    const gone = video(4, 60);
    await article('weg', recording(gone));
    // Trashed after publication: the published revision still names it.
    uow.store.for(TENANT).videos.get(gone)!.trashedAt = clock.now();
    await article('leden', {
      ...recording(video(5, 60)),
      lead: { nl: 'Voor leden.' },
      access: { level: 'members', teaser: 'lead' },
    });
    await article('hier', {});

    const overview = await invoker.run(useCases.getOverview, visitor, { props: {}, locale: 'nl' });
    const marks = Object.fromEntries(overview.entries.map((e) => [e.slug, e.recording]));
    expect(marks).toEqual({
      aflevering: { seconds: 754 },
      stil: { seconds: null },
      post: undefined,
      weg: undefined,
      leden: undefined,
      hier: undefined,
    });

    const read = await invoker.run(useCases.getPublished, visitor, {
      type: 'article',
      slug: 'hier',
      locale: 'nl',
    });
    expect(read.readMore?.map((e) => [e.slug, e.recording])).toEqual([
      ['leden', undefined],
      ['weg', undefined],
      ['post', undefined],
    ]);

    const profile = await invoker.run(useCases.getPublicPerson, visitor, {
      slug: 'maker',
      locale: 'nl',
    });
    expect(profile.articles).toEqual([
      expect.objectContaining({ slug: 'aflevering', recording: { seconds: 754 } }),
    ]);
  });

  it('marks a dossier member and a pinned card the same way', async () => {
    const dossier = await article('dossier', { type: 'page', profile: 'dossier' });
    const episode = await article('aflevering', {
      ...recording(video(1, 90)),
      dossiers: [{ itemId: dossier }],
    });
    await article('stuk', { dossiers: [{ itemId: dossier }] });
    const read = await invoker.run(useCases.getPublished, visitor, {
      type: 'article',
      slug: 'stuk',
      locale: 'nl',
    });
    expect(read.dossiers?.[0]?.members).toEqual([
      expect.objectContaining({ slug: 'aflevering', recording: { seconds: 90 } }),
    ]);
    const pinned = await invoker.run(useCases.getOverview, visitor, {
      props: { source: 'selection', pinned: [{ itemId: episode }] },
      locale: 'nl',
    });
    expect(pinned.entries.map((e) => e.recording)).toEqual([{ seconds: 90 }]);
  });
});
