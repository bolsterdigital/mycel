// Generated share cards in memory: publishing plans the card of exactly that locale,
// the job draws the current publication and prunes older cards, an own share image is a full
// override, and a site-wide change plans one walk. `runJobs` stands in for the worker; the
// memory image processor returns the drawing as JSON behind a PNG signature, so a test reads
// back what the card shows.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { parseJobPayload } from '../../jobs/types.js';
import { EXAMPLE_PNG } from '../../media/service.js';
import { anonymousPrincipal, systemPrincipal, type Principal } from '../../principal.js';
import { DEFAULT_THEME } from '../../theme/presets.js';
import { FakeClock, MemoryUnitOfWork, TENANT, pageDocument } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { renderShareCard, renderShareCards, shareCardKey, shareCardPrefix } from './share-card.js';

const OTHER = '00000000-0000-4000-8000-00000000bbbb';

describe('generated share cards', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let admin: Principal;
  let itemId: string;
  let first: string;

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
    const created = await invoker.run(useCases.createItem, admin, {
      slug: 'pepernoten',
      document: pageDocument({ title: { nl: 'Pepernoten', en: 'Spiced nuts' } }),
    });
    itemId = created.item.id;
    first = created.revision.id;
  });

  const reader = () => anonymousPrincipal(TENANT, ['content:read']);
  const card = (locale = 'nl', who = reader()) =>
    invoker.run(useCases.getShareCard, who, { itemId, locale }).then((r) => r.card);
  const publish = (revisionId: string, locale = 'nl') =>
    invoker.run(useCases.publishItem, admin, { itemId, revisionId, locale });
  const save = async (over: Record<string, unknown>) => {
    const { item } = await invoker.run(useCases.getItem, admin, { itemId });
    return (
      await invoker.run(useCases.updateItem, admin, {
        itemId,
        baseRevisionId: item.latestRevisionId,
        document: pageDocument({ title: { nl: 'Pepernoten', en: 'Spiced nuts' }, ...over }),
      })
    ).revision.id;
  };
  const open = (type: string) => uow.store.jobs.filter((j) => j.type === type && !j.doneAt);
  /** Every open card job, like the worker: handler, done, planned again on `next`. */
  async function runJobs() {
    for (let job = open('content.share-card')[0]; job; job = open('content.share-card')[0]) {
      const payload = parseJobPayload('content.share-card', job.payload);
      await uow.run(systemPrincipal(TENANT, 'jobs'), (ctx) => renderShareCard(ctx, payload));
      job.doneAt = clock.now();
    }
    for (let job = open('content.share-cards')[0]; job; job = open('content.share-cards')[0]) {
      const outcome = await uow.run(systemPrincipal(TENANT, 'jobs'), (ctx) =>
        renderShareCards(ctx)
      );
      job.doneAt = clock.now();
      if (outcome.next)
        uow.store.jobs.push({ ...job, id: `${job.id}+`, runAt: outcome.next, doneAt: null });
    }
  }
  const drawing = async (fingerprint: string, locale = 'nl') => {
    const bytes = await uow.blobs.get(shareCardKey(TENANT, itemId, locale, fingerprint));
    return JSON.parse(new TextDecoder().decode(bytes!.slice(4))) as Record<string, unknown>;
  };
  const files = async (locale = 'nl') => {
    const out: string[] = [];
    for await (const { key } of uow.blobs.list(shareCardPrefix(TENANT, itemId, locale)))
      out.push(key);
    return out;
  };

  it('publishing plans the card of that revision; the head has none until the job drew it', async () => {
    await publish(first);
    expect(open('content.share-card').map((j) => j.key)).toEqual([
      `content.share-card:${itemId}:nl:${first}`,
    ]);
    expect(await card()).toBeNull();
    await runJobs();
    const found = await card();
    expect(found?.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(await drawing(found!.fingerprint)).toMatchObject({
      title: 'Pepernoten',
      font: DEFAULT_THEME.headingFont,
      background: DEFAULT_THEME.palettes.light.primary.background,
      photo: null,
      logo: null,
    });
    // Only the published locale has one.
    expect(await card('en')).toBeNull();
  });

  it('a later draft changes nothing; republishing a new title replaces the card', async () => {
    await publish(first);
    await runJobs();
    const before = (await card())!.fingerprint;
    const draft = await save({ seo: { title: { nl: 'Zo onderzochten we de pepernoten' } } });
    await runJobs();
    expect((await card())!.fingerprint).toBe(before);
    await publish(draft);
    await runJobs();
    const after = (await card())!.fingerprint;
    expect(after).not.toBe(before);
    expect(await drawing(after)).toMatchObject({ title: 'Zo onderzochten we de pepernoten' });
    expect(await files()).toEqual([shareCardKey(TENANT, itemId, 'nl', after)]);
  });

  it('an own share image is a full override: no card, and an older one is removed', async () => {
    await publish(first);
    await runJobs();
    const media = await invoker.run(useCases.uploadMedia, admin, {
      filename: 'deel.png',
      contentType: 'image/png',
      bytes: EXAMPLE_PNG,
    });
    await publish(await save({ seo: { imageId: media.id } }));
    await runJobs();
    expect(await card()).toBeNull();
    expect(await files()).toEqual([]);
  });

  it('a job for an older revision draws what is published now, and nothing once unpublished', async () => {
    await publish(first);
    await invoker.run(useCases.unpublishItem, admin, { itemId, locale: 'nl' });
    await runJobs();
    expect(await files()).toEqual([]);
    expect(await card()).toBeNull();
  });

  it('the featured photo is drawn beside the title', async () => {
    const media = await invoker.run(useCases.uploadMedia, admin, {
      filename: 'foto.png',
      contentType: 'image/png',
      bytes: EXAMPLE_PNG,
    });
    await publish(await save({ featuredImageId: media.id }));
    await runJobs();
    expect((await drawing((await card())!.fingerprint)).photo).toEqual(expect.any(Number));
  });

  it('a restricted item gets a card from its teaser: the title, never a restricted photo', async () => {
    const closed = await invoker.run(useCases.uploadMedia, admin, {
      filename: 'leden.png',
      contentType: 'image/png',
      bytes: EXAMPLE_PNG,
      access: 'restricted',
    });
    const body = {
      id: 'body',
      type: 'heading',
      version: 1,
      props: { text: { nl: 'SENTINEL-BODY' } },
    };
    await publish(
      await save({
        lead: { nl: 'Voor leden.' },
        featuredImageId: closed.id,
        blocks: [body],
        access: { level: 'members', teaser: 'lead' },
      })
    );
    await runJobs();
    const found = await card();
    const drawn = await drawing(found!.fingerprint);
    expect(drawn).toMatchObject({ title: 'Pepernoten', photo: null });
    expect(JSON.stringify(drawn)).not.toContain('SENTINEL');
  });

  it('a theme change plans one walk that redraws every published locale', async () => {
    await publish(first);
    await runJobs();
    const before = (await card())!.fingerprint;
    const theme = await invoker.run(useCases.getSiteTheme, admin, {});
    await invoker.run(useCases.updateSiteTheme, admin, {
      baseVersion: theme.version,
      theme: { ...DEFAULT_THEME, headingFont: 'mycel-serif' },
    });
    expect(open('content.share-cards')).toHaveLength(1);
    await runJobs();
    const after = (await card())!.fingerprint;
    expect(after).not.toBe(before);
    expect(await drawing(after)).toMatchObject({ font: 'mycel-serif' });
    expect(await files()).toEqual([shareCardKey(TENANT, itemId, 'nl', after)]);
  });

  it('another tenant cannot read the card of this item', async () => {
    await publish(first);
    await runJobs();
    await expect(card('nl', anonymousPrincipal(OTHER, ['content:read']))).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
