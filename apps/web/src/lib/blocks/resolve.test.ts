// The real resolver source over the in-memory unit of work (brief #8c § 1): what a reference
// resolves to is the access boundary of every representation, so each fail-closed case is
// checked against the registry, not against a stub. A public image gets its variants; a
// restricted or deleted one is null. An item is a path only when it is published in the asked
// locale with a public published revision, in the route grammar of #8c2.
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_PNG,
  Invoker,
  anonymousPrincipal,
  buildRegistry,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { MemoryUnitOfWork, probeForm } from '@mycel/core/testing';
import { resolveDocument, runtimeSource } from './resolve.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const FORM = '01900000-0000-7000-8000-00000000f0aa';

async function setup() {
  const uow = new MemoryUnitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(TENANT, 'test');
  await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(FORM)));
  const upload = (access: 'public' | 'restricted' = 'public') =>
    invoker.run(useCases.uploadMedia, admin, {
      filename: 'pixel.png',
      contentType: 'image/png',
      bytes: EXAMPLE_PNG,
      access,
    });
  const page = async (
    slug: string,
    publish: string[],
    access: Record<string, unknown> = {},
    type: 'page' | 'article' = 'page'
  ) => {
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: {
        type,
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Titel', en: 'Title' },
        blocks: [{ type: 'heading', version: 1, props: { text: { nl: 'Kop', en: 'Heading' } } }],
        ...access,
      },
    });
    for (const locale of publish)
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
    return item.id;
  };
  const reader = anonymousPrincipal(TENANT, ['content:read', 'forms:read', 'media:read']);
  return {
    uow,
    invoker,
    upload,
    page,
    source: runtimeSource({ invoker, uow, reader, defaultLocale: 'nl' }),
  };
}

describe('runtimeSource', () => {
  it('gives a public image its variants and hides a restricted or deleted one', async () => {
    const { source, upload, invoker } = await setup();
    const open = await upload();
    const closed = await upload('restricted');
    const gone = await upload();
    await invoker.run(useCases.deleteMedia, systemPrincipal(TENANT, 'test'), { id: gone.id });

    const found = await source.media(open.id);
    expect(found?.variants.every((v) => v.path.startsWith(`/media/${open.id}/`))).toBe(true);
    // The source passes the view on; the model turns anything not public into null.
    expect((await source.media(closed.id))?.access).toBe('restricted');
    expect(await source.media(gone.id)).toBeNull();
    expect(await source.media('01900000-0000-7000-8000-0000000000ff')).toBeNull();
  });

  it('gives an item a path only when it is public and published in that locale', async () => {
    const { source, page, invoker } = await setup();
    const both = await page('both', ['nl', 'en']);
    const nlOnly = await page('nl-only', ['nl']);
    const draft = await page('draft', []);
    const members = await page('members', ['nl'], {
      access: { level: 'members', teaser: { blocks: 1 } },
    });
    const author = await invoker.run(useCases.createAuthor, systemPrincipal(TENANT, 'test'), {
      slug: 'sam',
      name: 'Sam',
    });
    const article = await page('article', ['nl'], { authorIds: [author.id] }, 'article');

    expect(await source.itemPath(both, 'nl')).toBe('/both');
    expect(await source.itemPath(both, 'en')).toBe('/en/both');
    expect(await source.itemPath(nlOnly, 'nl')).toBe('/nl-only');
    expect(await source.itemPath(nlOnly, 'en')).toBeNull();
    expect(await source.itemPath(draft, 'nl')).toBeNull();
    expect(await source.itemPath(members, 'nl')).toBeNull();
    expect(await source.itemPath(article, 'nl')).toBe('/articles/article');
    expect(await source.itemPath('01900000-0000-7000-8000-0000000000ff', 'nl')).toBeNull();
  });

  it('resolves a document: restricted image renders nothing, unpublished target drops out', async () => {
    const { source, upload, page } = await setup();
    const open = await upload();
    const closed = await upload('restricted');
    const live = await page('live', ['nl']);
    const draft = await page('draft', []);
    const image = (mediaId: string) => ({
      id: `img-${mediaId.slice(-2)}`,
      type: 'image' as const,
      version: 1 as const,
      props: {
        mediaId,
        decorative: false,
        alt: { nl: 'Alt' },
        layout: 'content' as const,
      },
    });
    const model = await resolveDocument(
      source,
      {
        locale: 'nl',
        title: 'Titel',
        blocks: [
          image(open.id),
          image(closed.id),
          {
            id: 'cta',
            type: 'cta',
            version: 1,
            props: {
              variant: 'band',
              title: { nl: 'Doe mee' },
              actions: [
                { label: { nl: 'Live' }, target: { kind: 'item', itemId: live } },
                { label: { nl: 'Concept' }, target: { kind: 'item', itemId: draft } },
              ],
              width: 'content',
              align: 'start',
            },
          },
          { id: 'form', type: 'signup-form', version: 1, props: { formId: FORM } },
        ],
      },
      { base: '/probe', fallbackLocale: 'nl' }
    );
    const [a, b, cta, form] = model.blocks;
    expect(a?.type === 'image' && a.image?.src).toBe(`/media/${open.id}/w1.webp`);
    expect(b?.type === 'image' && b.image).toBeNull();
    expect(JSON.stringify(model)).not.toContain(closed.id);
    expect(cta?.type === 'cta' && cta.actions).toEqual([{ label: 'Live', href: '/live' }]);
    expect(model.links).toEqual({ [live]: '/live', [draft]: null });
    expect(form?.type === 'form' && form.form?.submitLabel).toBe('Aanmelden');
    expect(form?.type === 'form' && form.form?.startedToken).toBeTruthy();
  });
});
