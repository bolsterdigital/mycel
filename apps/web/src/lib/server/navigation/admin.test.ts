// The item form's reading of what was posted: which refusal an empty or wrong target gets, and
// that a saved node keeps what the form does not show (other locales, sub-items), and which
// anchor a content link gets.
import { describe, expect, it } from 'vitest';
import { nodeFromForm } from './admin.js';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

describe('nodeFromForm', () => {
  it('asks for a target when nothing is chosen and no address is typed', () => {
    expect(nodeFromForm(form({ target: '', url: '' }), 'nl', 'link', 'n', null)).toBe(
      'admin.navigation.error.targetRequired'
    );
    expect(nodeFromForm(form({}), 'nl', 'link', 'n', null)).toBe(
      'admin.navigation.error.targetRequired'
    );
  });

  it('calls a typed address that does not parse a wrong address', () => {
    expect(nodeFromForm(form({ target: '', url: 'elders' }), 'nl', 'link', 'n', null)).toBe(
      'admin.navigation.error.address'
    );
    expect(nodeFromForm(form({ target: 'url', url: '' }), 'nl', 'link', 'n', null)).toBe(
      'admin.navigation.error.address'
    );
  });

  it('keeps the other locales and the sub-items of the node it replaces', () => {
    const current = {
      id: 'n',
      kind: 'link' as const,
      label: { nl: 'Oud', en: 'Old' },
      target: { kind: 'url' as const, href: '/oud' },
      children: [
        {
          id: 'c',
          kind: 'link' as const,
          target: { kind: 'system' as const, page: 'home' as const },
        },
      ],
    };
    expect(
      nodeFromForm(
        form({ target: 'url', url: '/nieuw', label: 'Nieuw' }),
        'nl',
        'link',
        'n',
        current
      )
    ).toEqual({
      ...current,
      label: { nl: 'Nieuw', en: 'Old' },
      target: { kind: 'url', href: '/nieuw' },
    });
  });

  describe('anchor', () => {
    const page = '0190d1a4-0000-7000-8000-000000000001';
    const other = '0190d1a4-0000-7000-8000-000000000002';
    const current = {
      id: 'n',
      kind: 'link' as const,
      target: { kind: 'content' as const, itemId: page, anchor: 'oud' },
    };
    const anchorOf = (fields: Record<string, string>) => {
      const node = nodeFromForm(form(fields), 'nl', 'link', 'n', current);
      return typeof node === 'string' || node.kind !== 'link' || node.target.kind !== 'content'
        ? node
        : node.target.anchor;
    };

    it('takes the chosen part of the page the form offered, or none', () => {
      expect(anchorOf({ target: page, anchorFor: page, anchor: 'kop' })).toBe('kop');
      expect(anchorOf({ target: page, anchorFor: page, anchor: '' })).toBeUndefined();
    });

    it('drops the choice when the link goes to another page, whose parts it did not show', () => {
      expect(anchorOf({ target: other, anchorFor: page, anchor: 'kop' })).toBeUndefined();
    });

    it('keeps the anchor without the choice while the target stays', () => {
      expect(anchorOf({ target: page })).toBe('oud');
      expect(anchorOf({ target: other })).toBeUndefined();
    });
  });
});
