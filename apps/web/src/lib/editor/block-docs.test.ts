// Drift check of `docs/reference/blocks.md` (brief content-editor § B): the file is what
// block-docs.ts writes, formatted by Prettier as `format:check` wants it. `npm run docs:blocks`
// (UPDATE_BLOCK_DOCS=1) rewrites it. And every label, type and value the block forms show has
// copy in both admin catalogs, so a new field cannot reach the form as a raw key.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, BLOCK_TYPES, type BlockField } from '@mycel/core';
import { en } from '../../i18n/en.js';
import { nl } from '../../i18n/nl.js';
import { blockReference } from './block-docs.js';

const path = fileURLToPath(new URL('../../../../../docs/reference/blocks.md', import.meta.url));

describe('docs/reference/blocks.md', () => {
  it('is what the registry generates', async () => {
    const expected = await format(blockReference(), {
      ...(await resolveConfig(path)),
      filepath: path,
    });
    if (process.env['UPDATE_BLOCK_DOCS']) writeFileSync(path, expected);
    expect(readFileSync(path, 'utf8'), 'run `npm run docs:blocks`').toBe(expected);
  });
});

describe('block form copy', () => {
  const keys = (fields: readonly BlockField[]): string[] =>
    fields.flatMap((f) => [
      `admin.block.field.${f.key}`,
      ...(f.kind === 'choice' ? f.options.map((o) => `admin.block.option.${o}`) : []),
      ...('fields' in f ? keys(f.fields) : []),
    ]);
  const needed = [
    ...BLOCK_TYPES.map((t) => `admin.block.type.${t}`),
    ...BLOCK_TYPES.flatMap((t) => keys(BLOCK_DEFINITIONS[t].fields)),
  ];

  it.each([
    ['en', en],
    ['nl', nl],
  ] as const)('has every label, type and value in %s', (_, catalog) => {
    expect(needed.filter((k) => !(k in catalog))).toEqual([]);
  });
});
