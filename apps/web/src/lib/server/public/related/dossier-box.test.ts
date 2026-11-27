import { describe, expect, it } from 'vitest';
import { exampleId } from '@mycel/core';
import { renderDossiers } from './dossier-box.js';

const member = (n: number, type: 'article' | 'page') => ({
  id: exampleId(0xd100 + n),
  type,
  slug: `stuk-${n}`,
  revisionId: exampleId(0xd200 + n),
  date: '2026-11-19T10:00:00.000Z',
  title: `Stuk ${n}`,
  summary: null,
  imageId: null,
  event: null,
  pinned: false,
  restricted: false,
});

const dossier = {
  id: exampleId(0xd001),
  slug: 'wonen',
  revisionId: exampleId(0xd002),
  title: 'Betaalbaar wonen',
  lead: 'Alles over wonen.',
  members: [member(1, 'article'), member(2, 'page')],
};

describe('the dossier box (MY-260)', () => {
  it('shows nothing for an item without a dossier', () => {
    expect(renderDossiers({}, 'nl', 'nl', 'Europe/Amsterdam')).toBeNull();
    expect(renderDossiers({ dossiers: [] }, 'nl', 'nl', 'Europe/Amsterdam')).toBeNull();
  });

  it('links the dossier and its members at their own paths, with a date in the locale', () => {
    const box = renderDossiers({ dossiers: [dossier] }, 'nl', 'nl', 'Europe/Amsterdam')!;
    expect(box.partOf).toBe('Onderdeel van het dossier');
    expect(box.boxes[0]).toMatchObject({
      href: '/wonen',
      title: 'Betaalbaar wonen',
      lead: 'Alles over wonen.',
      revisionId: dossier.revisionId,
    });
    expect(box.boxes[0]!.members.map((m) => m.href)).toEqual(['/articles/stuk-1', '/stuk-2']);
    expect(box.boxes[0]!.members[0]!.date).toEqual({
      iso: '2026-11-19',
      label: '19 november 2026',
    });
  });

  it('prefixes another locale than the default, and carries the revisions the ETag hashes', () => {
    const box = renderDossiers({ dossiers: [dossier] }, 'en', 'nl', 'Europe/Amsterdam')!;
    expect(box.partOf).toBe('Part of the dossier');
    expect(box.boxes[0]!.href).toBe('/en/wonen');
    expect(box.boxes[0]!.members.map((m) => [m.href, m.revisionId])).toEqual([
      ['/en/articles/stuk-1', exampleId(0xd201)],
      ['/en/stuk-2', exampleId(0xd202)],
    ]);
  });
});
