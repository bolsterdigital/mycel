// `docs/reference/blocks.md`, generated from the registry (brief content-editor § B, scope brief
// addition): every block type with its fields as the admin shows them, the enumerated values,
// what it references and its examples, plus the Markdown subset of rich text. block-docs.test.ts
// fails when the file differs from what this writes, so the reference cannot drift from the
// registry; `npm run docs:blocks` rewrites it. Generated here and not in core, because the field
// labels are the admin's catalog copy. Rejected: a hand-kept reference (it drifted the day a type
// got a field) and generating from the JSON Schema (it knows types, not what an editor sees).

import { BLOCK_DEFINITIONS, BLOCK_TYPES, type BlockField } from '@mycel/core';
import { en, type UiKey } from '../../i18n/en.js';

const label = (key: string) => en[`admin.block.field.${key}` as UiKey] ?? key;

function kind(f: BlockField): string {
  switch (f.kind) {
    case 'text':
      return `${f.localized ? 'localised ' : ''}${f.multiline ? 'multi-line ' : ''}text`;
    case 'caption':
      return 'localised caption: the file’s, none, or its own per locale';
    case 'rich-text':
      return 'localised rich text (Markdown subset in the no-JS form)';
    case 'media':
      return 'image (media id)';
    case 'reference':
      return `${f.to} reference (id)`;
    case 'choice':
      return `one of ${f.options.map((o) => `\`${o}\``).join(', ')}`;
    case 'boolean':
      return 'yes or no';
    case 'actions':
      return `${f.min}–${f.max} buttons: a localised label and an item or a URL`;
    case 'group':
      return 'group';
    case 'list':
      return `list of ${f.min}–${f.max}`;
  }
}

function presence(f: BlockField): string {
  if ('optional' in f && f.optional === 'omit') return 'optional';
  if ('optional' in f && f.optional === 'null') return 'optional (null when empty)';
  if (f.kind === 'caption') return 'optional';
  return 'required';
}

function rows(fields: readonly BlockField[], prefix = ''): string[] {
  return fields.flatMap((f) => [
    `| \`${prefix}${f.key}\` | ${label(f.key)} | ${kind(f)} | ${presence(f)} |`,
    ...(f.kind === 'group' || f.kind === 'list'
      ? rows(f.fields, `${prefix}${f.key}${f.kind === 'list' ? '[]' : ''}.`)
      : []),
  ]);
}

export function blockReference(): string {
  const out = [
    '# Blocks',
    '',
    '<!-- Generated from the block registry by apps/web/src/lib/editor/block-docs.ts. Do not edit: run `npm run docs:blocks`. -->',
    '',
    'Every block type a page or article can hold (ADR 004, ADR 013 rule 2, ADR 020), as `packages/core/src/content/block-types.ts` defines it: its props as the admin edits them, its enumerated values and its examples. A block is stored as `{ id, type, version, props }`; agents and the API write the same props through the block operations (`content.block.insert`, `move`, `remove`, `set_props`, `split_insert`). The JSON Schema of every type is in `/openapi.json` and the MCP tool list.',
    '',
    'The **label** is the English admin copy; **presence** says whether a published block needs the field. A localised field holds one value per locale of the document; publishing a locale needs a value in it for every required field and every optional one that is filled in another locale.',
    '',
  ];
  for (const type of BLOCK_TYPES) {
    const d = BLOCK_DEFINITIONS[type];
    out.push(`## \`${type}\` (${en[`admin.block.type.${type}` as UiKey]})`, '');
    out.push(`Version ${d.version}.`, '');
    if (d.fields.length) {
      out.push('| Prop | Label | Kind | Presence |', '| --- | --- | --- | --- |');
      out.push(...rows(d.fields), '');
    } else out.push('No props.', '');
    out.push(
      `Examples: ${d.examples
        .map((e) => `\`${e.name}\`${e.note ? ` (${e.note.replace(/\.$/, '')})` : ''}`)
        .join(', ')}.`,
      ''
    );
  }
  out.push(
    '## Rich text in the no-JavaScript form',
    '',
    'A rich-text field is a `textarea` with a Markdown subset that reads back into exactly the stored document (`apps/web/src/lib/editor/markdown.ts`):',
    '',
    '| Write | For |',
    '| --- | --- |',
    '| `## `, `### `, `#### ` at the start of a line | a heading at relative level 1, 2 or 3 (h2 to h4 at the top of a page) |',
    '| `**bold**`, `_italic_`, `` `code` `` | marks; they switch on and off, so they may start or end inside a word |',
    '| `- ` or `1. ` at the start of a line, indented by the marker’s width to nest | a bullet or numbered list, three levels deep at most |',
    '| a blank line | a new paragraph |',
    '| `\\` at the end of a line, or `<br>` | a line break inside a paragraph |',
    '| `[text](https://…)`, `[text](/path)`, `[text](mailto:…)`, `[text](item:<id>)` | a link; `item:` links to a page or article of the site by id |',
    '| `[text][^1]` and a line `[^1]: note` at the end | a footnote on that text |',
    '| `\\` before `*`, `_`, `` ` ``, `[` or `]`; `&#n;` with a character code | the character itself |',
    '',
    'A single newline inside a paragraph is a space, as in Markdown. Text that is unchanged in the form keeps its stored JSON exactly.',
    ''
  );
  return out.join('\n');
}
