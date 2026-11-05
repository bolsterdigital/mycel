import { describe, expect, it } from 'vitest';
import { ContentDocument } from '../content/model.js';
import { compareMedia, mediaMissingAlt, type MediaOrder } from './listing.js';
import type { MediaRecord } from './model.js';

const A = '01900000-0000-7000-8000-00000000000a';
const B = '01900000-0000-7000-8000-00000000000b';

const doc = (over: Record<string, unknown>, locales = ['nl', 'en']) =>
  ContentDocument.parse({
    type: 'page',
    title: Object.fromEntries(locales.map((locale) => [locale, 'Titel'])),
    defaultLocale: 'nl',
    locales,
    blocks: [],
    ...over,
  });
const image = (mediaId: string, alt: Record<string, string> | null) => ({
  id: `b-${mediaId.slice(-1)}`,
  type: 'image',
  version: 1,
  props: { mediaId, decorative: alt === null, alt },
});

describe('mediaMissingAlt', () => {
  it('finds an image without text in one of the locales of its document', () => {
    expect(mediaMissingAlt(doc({ blocks: [image(A, { nl: 'Foto' })] }))).toEqual([A]);
  });

  it('is content with text in every locale, in every locale the document has', () => {
    expect(mediaMissingAlt(doc({ blocks: [image(A, { nl: 'Foto', en: 'Photo' })] }))).toEqual([]);
    expect(mediaMissingAlt(doc({ blocks: [image(A, { nl: 'Foto' })] }, ['nl']))).toEqual([]);
  });

  it('asks nothing of a decorative image', () => {
    expect(mediaMissingAlt(doc({ blocks: [image(A, null)] }))).toEqual([]);
  });

  it('looks inside a block with several images, and names a file once', () => {
    const gallery = {
      id: 'g',
      type: 'gallery',
      version: 1,
      props: {
        images: [
          { mediaId: A, decorative: false, alt: { nl: 'Foto' } },
          { mediaId: A, decorative: false, alt: { en: 'Photo' } },
          { mediaId: B, decorative: false, alt: { nl: 'Foto', en: 'Photo' } },
        ],
      },
    };
    expect(mediaMissingAlt(doc({ blocks: [gallery] }))).toEqual([A]);
  });

  it('takes a hero without alt for decorative, and a half described one for lacking', () => {
    expect(mediaMissingAlt(doc({ heroImageId: A }))).toEqual([]);
    expect(mediaMissingAlt(doc({ heroImageId: A, heroAlt: { nl: 'Foto' } }))).toEqual([A]);
  });

  it('has no alt to miss on a featured image', () => {
    expect(mediaMissingAlt(doc({ featuredImageId: A }))).toEqual([]);
  });
});

describe('compareMedia', () => {
  const m = (id: string, filename: string, sizeBytes: number, day: number) =>
    ({ id, filename, sizeBytes, createdAt: new Date(Date.UTC(2026, 0, day)) }) as MediaRecord;
  const all = [m('1', 'b', 10, 3), m('2', 'Één', 30, 1), m('3', 'a', 10, 2)];
  const ids = (order: MediaOrder) => [...all].sort(compareMedia(order)).map((x) => x.id);

  it('orders names by the root collation, an accent with its letter', () => {
    expect(ids({ by: 'name', direction: 'asc' })).toEqual(['3', '1', '2']);
  });

  it('falls to the id in the same direction, so a tie has one place', () => {
    expect(ids({ by: 'size', direction: 'asc' })).toEqual(['1', '3', '2']);
    expect(ids({ by: 'size', direction: 'desc' })).toEqual(['2', '3', '1']);
  });

  it('orders by the upload', () => {
    expect(ids({ by: 'created', direction: 'desc' })).toEqual(['1', '3', '2']);
  });
});
