// A lead proposal reads only the prose blocks an editor chose, as plain text in one locale.
// The text of a link is kept, its target is not; a footnote's marker and note stay home. Rejected:
// sending the whole article or its Markdown, which would disclose unselected blocks, link targets
// and note text the task does not need.

import { z } from 'zod';
import { allBlocks } from '../content/blocks.js';
import type { ContentDocument } from '../content/model.js';

/** The most extracted text one lead request may send; longer selections are refused, never cut. */
export const LEAD_SOURCE_MAX = 3000;

export const LeadBlockIds = z
  .array(z.string().min(1).max(200))
  .min(1)
  .max(3)
  .refine((ids) => new Set(ids).size === ids.length);

type Node = {
  type: string;
  text?: string;
  marks?: { type: string }[];
  content?: Node[];
};

const inline = (n: Node): string => {
  if (n.type === 'hard_break') return '\n';
  if (typeof n.text === 'string')
    return n.marks?.some((m) => m.type === 'footnote_reference') ? '' : n.text;
  return (n.content ?? []).map(inline).join('');
};

/** Every paragraph and heading on a line of its own, list items included. */
function lines(n: Node): string[] {
  if (n.type === 'paragraph' || n.type === 'heading') return [inline(n)];
  return (n.content ?? []).flatMap(lines);
}

/** One rich-text value as plain text: paragraphs apart by a blank line, no markup. */
export function plainProse(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  return lines(doc as Node)
    .map((line) =>
      line
        .split('\n')
        .map((part) => part.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .trim()
    )
    .filter(Boolean)
    .join('\n\n');
}

export type LeadSource =
  | { ok: true; passages: { blockId: string; text: string }[] }
  | { ok: false; issue: 'lead-source' | 'lead-too-long' };

/** The rich-text blocks an article offers as a lead source in one locale, in document order. */
export function leadCandidates(
  doc: ContentDocument,
  locale: string
): { blockId: string; text: string }[] {
  return allBlocks(doc.blocks)
    .filter((b) => b.type === 'rich-text')
    .map((b) => ({
      blockId: b.id,
      text: plainProse((b.props as { content: Partial<Record<string, unknown>> }).content[locale]),
    }))
    .filter((c) => c.text !== '');
}

/**
 * The chosen passages, checked: each id is a rich-text block with words in this locale, the ids
 * follow document order, and the text together stays within `LEAD_SOURCE_MAX`.
 */
export function leadSource(doc: ContentDocument, blockIds: string[], locale: string): LeadSource {
  if (!LeadBlockIds.safeParse(blockIds).success) return { ok: false, issue: 'lead-source' };
  const candidates = leadCandidates(doc, locale);
  const order = blockIds.map((id) => candidates.findIndex((c) => c.blockId === id));
  if (order.some((at, i) => at < 0 || (i > 0 && at <= order[i - 1]!)))
    return { ok: false, issue: 'lead-source' };
  const passages = order.map((at) => candidates[at]!);
  const length = passages.reduce((sum, p) => sum + p.text.length, 0);
  if (length > LEAD_SOURCE_MAX) return { ok: false, issue: 'lead-too-long' };
  return { ok: true, passages };
}
