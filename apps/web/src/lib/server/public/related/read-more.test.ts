import { describe, expect, it } from 'vitest';
import { exampleId } from '@mycel/core';
import type { ResolveSource } from '../../../blocks/resolve.js';
import { renderReadMore } from './read-more.js';

const entry = (n: number, restricted = false) => ({
  id: exampleId(0xe100 + n),
  type: 'article' as const,
  slug: `stuk-${n}`,
  revisionId: exampleId(0xe200 + n),
  date: '2026-11-19T10:00:00.000Z',
  title: `Stuk ${n}`,
  summary: n === 1 ? 'Kort gezegd.' : null,
  imageId: null,
  event: null,
  pinned: false,
  restricted,
});

// No card in these cases has an image, so the source is never asked for one.
const source = {} as ResolveSource;

describe('read more under an article (MY-304)', () => {
  it('shows nothing for an item without cards', async () => {
    expect(await renderReadMore({}, source, 'nl', 'nl', 'Europe/Amsterdam')).toBeNull();
    expect(
      await renderReadMore({ readMore: [] }, source, 'nl', 'nl', 'Europe/Amsterdam')
    ).toBeNull();
  });

  it('gives each card its address, date and access in the asked locale', async () => {
    const more = await renderReadMore(
      { readMore: [entry(1), entry(2, true)] },
      source,
      'en',
      'nl',
      'Europe/Amsterdam'
    );
    expect(more).toMatchObject({ title: 'Read more', restricted: 'Members only' });
    expect(more?.cards).toEqual([
      {
        id: exampleId(0xe101),
        href: '/en/articles/stuk-1',
        title: 'Stuk 1',
        summary: 'Kort gezegd.',
        date: { iso: '2026-11-19', label: 'November 19, 2026' },
        image: null,
        restricted: false,
        revisionId: exampleId(0xe201),
      },
      expect.objectContaining({ href: '/en/articles/stuk-2', restricted: true }),
    ]);
  });
});
