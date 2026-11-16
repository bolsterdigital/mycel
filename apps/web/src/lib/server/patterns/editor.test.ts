// The pure halves of the pattern steps: what the chooser's value names, and which run of blocks
// a save takes (ADR 013 rule 4). The steps themselves run the registry like every block action.
import { describe, expect, it } from 'vitest';
import type { Revision } from '@mycel/core';
import { patternInsert, patternRun } from './editor.js';

const P = '01900000-0000-7000-8000-0000000000aa';
const heading = (id: string, name?: string) => ({
  id,
  type: 'heading' as const,
  version: 1 as const,
  props: { text: { nl: id } },
  ...(name ? { name: { nl: name } } : {}),
});
const blocks = [
  heading('a'),
  heading('b', 'Oproep'),
  heading('c'),
] as Revision['document']['blocks'];

describe('patternInsert', () => {
  it('reads the end and a place before a block, and nothing else', () => {
    expect(patternInsert(`pattern:${P}|end`)).toEqual({ patternId: P, place: { at: 'end' } });
    expect(patternInsert(`pattern:${P}|before:b`)).toEqual({
      patternId: P,
      place: { before: 'b' },
    });
    expect(patternInsert(`heading|end`)).toBeNull();
    expect(patternInsert(`pattern:${P}|after:b`)).toBeNull();
    expect(patternInsert(`pattern:${P}|before:`)).toBeNull();
  });
});

describe('patternRun', () => {
  it('takes the run between two ids in either order, without ids and with names', () => {
    expect(patternRun(blocks, 'b', 'c')).toEqual([
      { type: 'heading', version: 1, props: { text: { nl: 'b' } }, name: { nl: 'Oproep' } },
      { type: 'heading', version: 1, props: { text: { nl: 'c' } } },
    ]);
    expect(patternRun(blocks, 'c', 'b')).toHaveLength(2);
    expect(patternRun(blocks, 'b', 'b')).toHaveLength(1);
  });

  it('reads an unknown id as the first or the last block', () => {
    expect(patternRun(blocks, '', '')).toHaveLength(3);
    expect(patternRun(blocks, 'x', 'a')).toHaveLength(1);
  });
});
