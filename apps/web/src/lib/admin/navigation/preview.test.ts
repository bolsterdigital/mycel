// The preview arranges core's resolution per placement: paths as the site builds them, the bar
// marked, and a footer column that shows nothing kept in its place instead of shifting the rest.
import { describe, expect, it } from 'vitest';
import type { NavigationDocument } from '@mycel/core';
import { previewOf } from './preview.js';

const ITEM = '0190a0a0-0000-7000-8000-000000000001';
const doc: NavigationDocument = {
  menus: [
    {
      id: 'main',
      name: 'Main',
      nodes: [
        { id: 'home', kind: 'link', target: { kind: 'system', page: 'home' } },
        { id: 'about', kind: 'link', target: { kind: 'content', itemId: ITEM, anchor: 'b1' } },
      ],
    },
    { id: 'empty', name: 'Empty', nodes: [] },
    {
      id: 'more',
      name: 'More',
      nodes: [
        { id: 'm', kind: 'link', label: { en: 'More' }, target: { kind: 'url', href: '/m' } },
      ],
    },
  ],
  placements: {
    main: { menuId: 'main', bar: ['about'] },
    actions: null,
    footer: [{ menuId: 'empty' }, { menuId: 'more', title: { en: 'Also' } }],
    legal: null,
  },
};

describe('previewOf', () => {
  it('builds site paths in a locale that is not the default, and marks the bar', () => {
    const p = previewOf(
      doc,
      {
        main: {
          nodes: [
            {
              id: 'home',
              kind: 'link',
              label: null,
              target: { kind: 'system', page: 'home' },
              children: [],
            },
            {
              id: 'about',
              kind: 'link',
              label: 'About',
              target: {
                kind: 'content',
                itemId: ITEM,
                type: 'page',
                slug: 'about',
                locale: 'en',
                anchor: 'b1',
              },
              children: [],
            },
          ],
          // An id that is also in a footer column: only the main navigation marks it.
          bar: ['about', 'm'],
        },
        actions: [],
        footer: [
          {
            title: 'Also',
            nodes: [
              {
                id: 'm',
                kind: 'link',
                label: 'More',
                target: { kind: 'url', href: '/m' },
                children: [],
              },
            ],
          },
        ],
        legal: null,
        prefooter: null,
      },
      'en',
      'nl'
    );
    expect(p.main?.items.map((i) => [i.href, i.system, i.inBar])).toEqual([
      ['/en', 'home', false],
      ['/en/about#block-b1', null, true],
    ]);
    expect(p.footer.map((f) => [f.menuId, f.title, f.items.length])).toEqual([
      ['empty', null, 0],
      ['more', 'Also', 1],
    ]);
    expect(p.actions).toBeNull();
    expect(p.footer[1]?.items[0]?.inBar).toBe(false);
  });
});
