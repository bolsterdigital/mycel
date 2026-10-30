// #11 E: one registry and validator across public reads, agent writes and native admin posts.
import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import { MemoryUnitOfWork } from '../testing/memory.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { EXAMPLE_PNG } from '../media/service.js';
import { FakeClock, MemoryBlobStore, TENANT } from '../testing/index.js';
import { bytesToBase64 } from '../util/bytes.js';
import { DEFAULT_THEME } from './presets.js';
import { DEFAULT_CHROME, SITE_IMAGES_REF } from './settings.js';

const a = '01900000-0000-7000-8000-00000000aa11';
const b = '01900000-0000-7000-8000-00000000bb11';
const chrome = {
  ...DEFAULT_CHROME,
  navigation: [{ href: '/en/about', label: { nl: 'Over', en: 'About' } }],
  footer: { nl: 'Voet', en: 'Footer' },
};

describe('site settings', () => {
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
  it('isolates sites and checks versions separately', async () => {
    expect(
      await invoker.run(useCases.getSiteTheme, anonymousPrincipal(a, ['content:read']), {})
    ).toMatchObject({ version: 0, value: DEFAULT_THEME });
    expect(
      await invoker.run(useCases.updateSiteChrome, systemPrincipal(a, 'test'), {
        baseVersion: 0,
        chrome,
      })
    ).toMatchObject({ version: 1 });
    expect(
      await invoker.run(useCases.getSiteChrome, anonymousPrincipal(b, ['content:read']), {})
    ).toMatchObject({ version: 0, value: DEFAULT_CHROME });
    expect(
      await invoker.run(useCases.updateSiteTheme, systemPrincipal(a, 'test'), {
        baseVersion: 0,
        theme: { ...DEFAULT_THEME, baseSize: 20 },
      })
    ).toMatchObject({ version: 1 });
    expect(
      await invoker.run(useCases.getSiteChrome, anonymousPrincipal(a, ['content:read']), {})
    ).toMatchObject({ version: 1, value: chrome });
    await expect(
      invoker.run(useCases.updateSiteChrome, systemPrincipal(a, 'test'), { baseVersion: 0, chrome })
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      invoker.run(useCases.updateSiteChrome, systemPrincipal(b, 'test'), {
        baseVersion: 0,
        chrome: { ...chrome, footer: { nl: '', en: '' } },
      })
    ).resolves.toMatchObject({ version: 1 });
  });
  it('rejects unsafe links and contrast failures at the use-case boundary', async () => {
    await expect(
      invoker.run(useCases.updateSiteChrome, systemPrincipal(b, 'test'), {
        baseVersion: 0,
        chrome: { ...chrome, navigation: [{ href: 'javascript:alert(1)', label: { en: 'Bad' } }] },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      invoker.run(useCases.updateSiteTheme, systemPrincipal(b, 'test'), {
        baseVersion: 0,
        theme: {
          ...DEFAULT_THEME,
          palettes: {
            ...DEFAULT_THEME.palettes,
            light: {
              ...DEFAULT_THEME.palettes.light,
              primary: { foreground: '#ffffff', background: '#ffffff' },
            },
          },
        },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      invoker.run(useCases.updateSiteTheme, anonymousPrincipal(b, ['content:read']), {
        baseVersion: 0,
        theme: DEFAULT_THEME,
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

// #86: the site's default image is the last link of an item's featured and share image chain.
describe('site images', () => {
  const system = systemPrincipal(TENANT, 'test');
  const setup = async () => {
    const clock = new FakeClock();
    const uow = new MemoryUnitOfWork({ clock, blobs: new MemoryBlobStore(clock) });
    const invoker = new Invoker(buildRegistry(), uow);
    const upload = async (contentType: 'image/png' | 'application/pdf', bytes: string) =>
      (
        await invoker.run(useCases.uploadMedia, system, {
          filename: contentType === 'image/png' ? 'p.png' : 'r.pdf',
          contentType,
          bytes,
        })
      ).id;
    const photo = await upload('image/png', EXAMPLE_PNG);
    const pdf = await upload(
      'application/pdf',
      bytesToBase64(new TextEncoder().encode('%PDF-1.7\n'))
    );
    const usages = () =>
      [...uow.store.for(TENANT).mediaUsages.values()]
        .filter((u) => u.ref === SITE_IMAGES_REF)
        .map((u) => u.mediaId);
    return { invoker, photo, pdf, usages };
  };

  it('stores the default image, protects it as a usage and feeds the chain', async () => {
    const { invoker, photo, usages } = await setup();
    expect(
      await invoker.run(useCases.getSiteImages, anonymousPrincipal(TENANT, ['content:read']), {})
    ).toEqual({ version: 0, value: { defaultImageId: null } });
    expect(
      await invoker.run(useCases.updateSiteImages, system, {
        baseVersion: 0,
        images: { defaultImageId: photo },
      })
    ).toEqual({ version: 1, value: { defaultImageId: photo } });
    expect(usages()).toEqual([photo]);
    await expect(invoker.run(useCases.deleteMedia, system, { id: photo })).rejects.toMatchObject({
      code: 'conflict',
    });

    const { item } = await invoker.run(useCases.createItem, system, {
      slug: 'zonder-beeld',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Titel' },
        blocks: [],
      },
    });
    const got = await invoker.run(useCases.getItem, system, { itemId: item.id });
    expect(got.effective.nl!.images).toMatchObject({
      hero: { mediaId: null, source: null },
      featured: { mediaId: photo, source: 'site' },
      share: { mediaId: photo, source: 'site' },
    });

    await invoker.run(useCases.updateSiteImages, system, {
      baseVersion: 1,
      images: { defaultImageId: null },
    });
    expect(usages()).toEqual([]);
    await expect(invoker.run(useCases.deleteMedia, system, { id: photo })).resolves.toMatchObject({
      id: photo,
    });
  });

  it('refuses what is not a usable image, a stale version and a reader', async () => {
    const { invoker, pdf, photo } = await setup();
    const update = (defaultImageId: string, baseVersion = 0, principal = system) =>
      invoker.run(useCases.updateSiteImages, principal, {
        baseVersion,
        images: { defaultImageId },
      });
    await expect(update(pdf)).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [{ path: 'images.defaultImageId', message: 'content.reference.media-not-image' }],
    });
    await expect(update('01900000-0000-7000-8000-00000000dddd')).rejects.toMatchObject({
      issues: [{ message: 'content.reference.media-unknown' }],
    });
    await expect(update(photo, 3)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      update(photo, 0, anonymousPrincipal(TENANT, ['content:read']))
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
