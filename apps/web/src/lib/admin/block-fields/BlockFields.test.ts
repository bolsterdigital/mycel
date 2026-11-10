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
