// The editor's steps keep a menu at two levels and the bar on top-level nodes; each result must
// still be a document core accepts, so the tests parse it with core's own schema and rules.
import { describe, expect, it } from 'vitest';
import { NavigationDocument, navigationIssues, type Menu } from '@mycel/core';
import {
  editMenu,
  moveNode,
  movesOf,
  nodeOf,
  removeMenu,
  removeNode,
  replaceNode,
  usedIn,
} from './menu-edit.js';

const link = (id: string) =>
  ({ id, kind: 'link', target: { kind: 'url', href: `/${id}` }, label: { nl: id } }) as const;

const menu = (): Menu => ({
  id: 'main',
  name: 'Main',
  nodes: [
    link('a'),
    { ...link('b'), children: [link('b1'), link('b2')] },
    { id: 'g', kind: 'group', label: { nl: 'Groep' }, children: [link('g1')] },
    link('c'),
  ],
});
const shape = (m: Menu | null) =>
  m?.nodes.map((n) => [n.id, ...(n.children ?? []).map((c) => c.id)].join('>')).join(' ');
const doc = (m = menu()) => ({
  menus: [m, { id: 'other', name: 'Other', nodes: [] }],
  placements: { main: { menuId: 'main', bar: ['a', 'c'] }, actions: null, footer: [], legal: null },
});
const valid = (d: unknown) => navigationIssues(NavigationDocument.parse(d));

describe('movesOf', () => {
  it('offers only what keeps two levels', () => {
    const m = menu();
    expect(movesOf(m, 'a')).toEqual(['down']);
    // A node with sub-items and a group cannot become a sub-item themselves.
    expect(movesOf(m, 'b')).toEqual(['up', 'down']);
    expect(movesOf(m, 'g')).toEqual(['up', 'down']);
    expect(movesOf(m, 'c')).toEqual(['up', 'in']);
    expect(movesOf(m, 'b1')).toEqual(['down', 'out']);
    expect(movesOf(m, 'b2')).toEqual(['up', 'out']);
    expect(movesOf(m, 'nope')).toEqual([]);
  });
});

describe('moveNode', () => {
  it('moves among siblings at both levels', () => {
    expect(shape(moveNode(menu(), 'a', 'down'))).toBe('b>b1>b2 a g>g1 c');
    expect(shape(moveNode(menu(), 'b2', 'up'))).toBe('a b>b2>b1 g>g1 c');
  });
  it('moves in under the node above, and out to just after its parent', () => {
    const into = moveNode(menu(), 'c', 'in');
    expect(shape(into)).toBe('a b>b1>b2 g>g1>c');
    expect(shape(moveNode(into!, 'c', 'out'))).toBe('a b>b1>b2 g>g1 c');
    expect(shape(moveNode(menu(), 'b1', 'out'))).toBe('a b>b2 b1 g>g1 c');
  });
  it('refuses a step the node cannot take', () => {
    expect(moveNode(menu(), 'a', 'up')).toBeNull();
    expect(moveNode(menu(), 'b', 'in')).toBeNull();
    expect(moveNode(menu(), 'g', 'in')).toBeNull();
    expect(moveNode(menu(), 'a', 'out')).toBeNull();
  });
  it('leaves a link without sub-items when its last one moves out', () => {
    const one: Menu = { ...menu(), nodes: [link('a'), link('c')] };
    const out = moveNode(moveNode(one, 'c', 'in')!, 'c', 'out')!;
    expect(shape(out)).toBe('a c');
    expect(valid({ ...doc(out), placements: doc().placements })).toEqual([]);
  });
});

describe('removeNode and replaceNode', () => {
  it('removes a node with its sub-items, or one sub-item', () => {
    expect(shape(removeNode(menu(), 'b'))).toBe('a g>g1 c');
    expect(shape(removeNode(menu(), 'g1'))).toBe('a b>b1>b2 g c');
    expect(removeNode(menu(), 'nope')).toBeNull();
  });
  it('replaces a node in place and keeps a sub-item a link', () => {
    const next = replaceNode(menu(), { ...link('b1'), label: { nl: 'Nieuw' } })!;
    expect(nodeOf(next, 'b1')).toMatchObject({ child: true, node: { label: { nl: 'Nieuw' } } });
    expect(replaceNode(menu(), { id: 'b1', kind: 'group', label: {}, children: [] })).toBeNull();
    expect(replaceNode(menu(), link('nope'))).toBeNull();
  });
});

describe('editMenu, usedIn and removeMenu', () => {
  it('drops a node from the bar when it leaves the top level', () => {
    const moved = editMenu(doc(), 'main', (m) => moveNode(m, 'c', 'in'))!;
    expect(moved.placements.main?.bar).toEqual(['a']);
    expect(valid(moved)).toEqual([]);
    const removed = editMenu(doc(), 'main', (m) => removeNode(m, 'a'))!;
    expect(removed.placements.main?.bar).toEqual(['c']);
    expect(valid(removed)).toEqual([]);
  });
  it('gives nothing for a menu that is gone or a step that fails', () => {
    expect(editMenu(doc(), 'nope', (m) => m)).toBeNull();
    expect(editMenu(doc(), 'main', () => null)).toBeNull();
  });
  it('names where the draft places a menu and keeps a placed menu', () => {
    const d = {
      ...doc(),
      placements: {
        main: { menuId: 'main', bar: [] },
        actions: null,
        footer: [{ menuId: 'main' }, { menuId: 'other' }],
        legal: { menuId: 'other' },
      },
    };
    expect(usedIn(d, 'main')).toEqual(['main', 'footer']);
    expect(usedIn(d, 'other')).toEqual(['footer', 'legal']);
    expect(removeMenu(d, 'main')).toBeNull();
    expect(removeMenu(doc(), 'other')?.menus.map((m) => m.id)).toEqual(['main']);
    expect(removeMenu(doc(), 'nope')).toBeNull();
  });
});
