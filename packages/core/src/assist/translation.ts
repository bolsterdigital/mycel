// Translation addresses stable field names and block ids, never array offsets in persisted state.
// Rejected: sending a whole revision to the model, which would disclose unselected fields.
import { z } from 'zod';
import { ContentDocument, localizedFields } from '../content/model.js';
import { RichTextDoc } from '../content/rich-text.js';
import { fromMarkdown, toMarkdown } from '../content/markdown.js';

export const TranslationResult = z.object({ values: z.record(z.string(), z.string()) }).strict();
export const TranslationTarget = z.string().min(1).max(200);
export const TranslationTargets = z
  .array(TranslationTarget)
  .min(1)
  .max(20)
  .refine((v) => new Set(v).size === v.length);
export type TranslationDescriptor = { from: string; to: string; targets: string[] };
export function expandTranslationTargets(doc: ContentDocument, targets: string[]): string[] {
  return targets.flatMap((target) => {
    const block = doc.blocks.find((candidate) => candidate.id === target);
    if (!block) return [target];
    return localizedFields(doc)
      .filter(({ path }) => path[0] === 'blocks' && doc.blocks[Number(path[1])]?.id === target)
      .map(({ path }) => `blocks.${target}.${path.slice(2).join('.')}`);
  });
}
export const encodeTranslation = (d: TranslationDescriptor) => `translate:${JSON.stringify(d)}`;
export function decodeTranslation(value: string): TranslationDescriptor | null {
  if (!value.startsWith('translate:')) return null;
  try {
    const parsed = z
      .object({ from: z.string(), to: z.string(), targets: TranslationTargets })
      .strict()
      .safeParse(JSON.parse(value.slice(10)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function field(doc: ContentDocument, target: string) {
  return localizedFields(doc).find(({ path }) => {
    if (path[0] !== 'blocks') return path.join('.') === target;
    const block = doc.blocks[Number(path[1])];
    return block && `blocks.${block.id}.${path.slice(2).join('.')}` === target;
  });
}
export function translationValue(
  doc: ContentDocument,
  target: string,
  locale: string
): string | null {
  const value = field(doc, target)?.value[locale];
  if (typeof value === 'string') return value;
  if (RichTextDoc.safeParse(value).success) return toMarkdown(value as z.infer<typeof RichTextDoc>);
  return null;
}
function structure(markdown: string) {
  const parsed = fromMarkdown(markdown);
  if (!parsed.ok) return null;
  const links: string[] = [];
  const headings: number[] = [];
  let items = 0;
  const visit = (node: {
    type: string;
    attrs?: Record<string, unknown>;
    marks?: { type: string; attrs?: Record<string, unknown> }[];
    content?: unknown[];
  }) => {
    if (node.type === 'heading') headings.push(Number(node.attrs?.level));
    if (node.type === 'list_item') items++;
    for (const mark of node.marks ?? [])
      if (mark.type === 'link')
        links.push(String(mark.attrs?.href ?? `item:${mark.attrs?.itemId}`));
    for (const child of node.content ?? []) visit(child as typeof node);
  };
  visit(parsed.doc as typeof parsed.doc);
  const notes = [...markdown.matchAll(/\[\^([\w-]+)\](?!:)/g)].map((m) => m[1]).sort();
  return {
    doc: parsed.doc,
    signature: JSON.stringify({ links: links.sort(), headings: headings.sort(), items, notes }),
  };
}
export function translatedValue(
  doc: ContentDocument,
  target: string,
  from: string,
  to: string,
  text: string
): unknown | null {
  const source = field(doc, target)?.value[from];
  if (typeof source === 'string') return text.trim() || null;
  if (!RichTextDoc.safeParse(source).success) return null;
  const before = structure(toMarkdown(source as z.infer<typeof RichTextDoc>));
  const after = structure(text);
  return before && after && before.signature === after.signature ? after.doc : null;
}
export function applyTranslation(
  doc: ContentDocument,
  target: string,
  locale: string,
  value: unknown
): ContentDocument | null {
  const found = field(doc, target);
  if (!found) return null;
  const path = found.path;
  const copy = structuredClone(doc);
  let at: unknown = copy;
  for (const part of path) {
    if (!at || typeof at !== 'object') return null;
    at = (at as Record<string, unknown>)[String(part)];
  }
  if (!at || typeof at !== 'object') return null;
  (at as Record<string, unknown>)[locale] = value;
  const parsed = ContentDocument.safeParse(copy);
  return parsed.success ? parsed.data : null;
}
