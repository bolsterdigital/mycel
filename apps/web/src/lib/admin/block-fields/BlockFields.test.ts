// SSR controls are the no-script storage contract: unknown and unread ids must remain editable.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import BlockFields from './BlockFields.svelte';

const id = '01900000-0000-7000-8000-00000000f000';
const props = {
  values: { 'b.f.p.formId': id },
  locales: ['nl'],
  idPrefix: 'f',
  prefix: 'b.f.',
  media: [],
  base: '/admin/probe',
  upload: false,
  invalid: [],
  locale: 'nl',
};
const refs = { items: [], people: [], personGroups: [] };
for (const type of ['form', 'signup-form'] as const)
  describe(type, () => {
    const block = { type, image: null };
    it('offers names as native options, retaining the stored id and a management link', () => {
      const html = render(BlockFields, {
        props: {
          ...props,
          block,
          references: { ...refs, forms: [{ id, label: 'Contact <ons>' }] },
        },
      }).body;
      expect(html).toContain('name="b.f.p.formId"');
      expect(html).toContain(`<option value="${id}" selected="">Contact &lt;ons></option>`);
      expect(html).toContain('href="/admin/probe/forms"');
      expect(html).not.toContain('<form');
    });
    it('keeps an unknown id selected even when the list is empty', () => {
      const html = render(BlockFields, {
        props: { ...props, block, references: { ...refs, forms: [] } },
      }).body;
      expect(html).toContain(
        `<option value="${id}" selected="">Ontbrekend formulier (${id})</option>`
      );
    });
    it('retains the raw editable reference without form access', () => {
      const html = render(BlockFields, {
        props: { ...props, block, references: { ...refs, forms: null } },
      }).body;
      expect(html).toContain(`value="${id}"`);
      expect(html).toContain('type="text"');
      expect(html).not.toContain('/admin/probe/forms');
      expect(html).not.toContain('<select name="b.f.p.formId"');
    });
  });

describe('overview', () => {
  const block = { type: 'overview' as const, image: null };
  const section = '01900000-0000-7000-8000-00000000f001';
  const item = '01900000-0000-7000-8000-00000000f002';
  const html = (sectionChoices?: { id: string; label: string }[]) =>
    render(BlockFields, {
      props: {
        ...props,
        block,
        values: {
          'b.f.p.sectionId': section,
          'b.f.p.pinned.rows': '1',
          'b.f.p.pinned.0.itemId': item,
        },
        references: {
          ...refs,
          items: [{ id: item, label: 'Pepernoten (/pepernoten)' }],
          ...(sectionChoices ? { sectionChoices } : {}),
        },
      },
    }).body;
  it('offers the sections by name and the pins by title, both native selects', () => {
    const out = html([{ id: section, label: 'Buurt' }]);
    expect(out).toContain('<select name="b.f.p.sectionId"');
    expect(out).toContain('<option value="">Alle rubrieken</option>');
    expect(out).toContain(`<option value="${section}" selected="">Buurt</option>`);
    expect(out).toContain(`<option value="${item}" selected="">Pepernoten (/pepernoten)</option>`);
  });
  it('keeps the section id editable where no list is offered', () => {
    const out = html();
    expect(out).not.toContain('<select name="b.f.p.sectionId"');
    expect(out).toContain(`value="${section}"`);
  });
});

describe('overview dossier filter (MY-260)', () => {
  const dossier = '01900000-0000-7000-8000-00000000f003';
  const gone = '01900000-0000-7000-8000-00000000f004';
  const html = (chosen: string) =>
    render(BlockFields, {
      props: {
        ...props,
        block: { type: 'overview', image: null },
        values: { 'b.f.p.dossierId': chosen },
        references: { ...refs, dossierChoices: [{ id: dossier, label: 'Betaalbaar wonen' }] },
      },
    }).body;
  it('offers only dossier pages, and keeps one that is gone selected and named', () => {
    expect(html(dossier)).toContain(
      `<option value="${dossier}" selected="">Betaalbaar wonen</option>`
    );
    expect(html(dossier)).toContain('<option value="">Geen dossierfilter</option>');
    expect(html(gone)).toContain(
      `<option value="${gone}" selected="">Ontbrekend dossier (${gone})</option>`
    );
  });
});
