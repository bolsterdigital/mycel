import { describe, expect, it } from 'vitest';
import { projectDocument } from './public.js';
import type { Block } from './blocks.js';

const heading = (id: string, text: Record<string, string>): Block =>
  ({ id, type: 'heading', version: 1, props: { text } }) as unknown as Block;

describe('projectDocument', () => {
  const doc = {
    title: { nl: 'Over ons', en: 'About us' },
    blocks: [
      heading('a', { nl: 'Wie we zijn', en: 'Who we are' }),
      heading('b', { nl: 'Alleen Nederlands' }),
    ],
  };

  it('keeps only the asked locale of every field', () => {
    const nl = projectDocument(doc, 'nl');
    expect(nl.title).toBe('Over ons');
    expect(nl.blocks.map((b) => b.props)).toEqual([
      { text: { nl: 'Wie we zijn' } },
      { text: { nl: 'Alleen Nederlands' } },
    ]);
  });

  it('leaves out a block that lacks a required value in the locale', () => {
    const en = projectDocument(doc, 'en');
    expect(en.blocks.map((b) => b.id)).toEqual(['a']);
    expect(projectDocument({ ...doc, title: { nl: 'x' } }, 'en').title).toBe('');
  });
});
