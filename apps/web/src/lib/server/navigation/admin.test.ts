// The item form's reading of what was posted: which refusal an empty or wrong target gets, and
// that a saved node keeps what the form does not show (other locales, sub-items).
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
});
