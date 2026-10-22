// Heading levels come from context, never from stored data (ADR 004 rule 3, ADR 020 rule 2): the
// document title is the only h1 (depth 1), a top-level block's title is depth 2, a FAQ question
// depth 3, and a rich-text heading of relative level n sits n below the heading it is under.
// Above h6 there is no element, so a tree that would get there is refused rather than clamped:
// a clamp would silently put two levels on one, which is exactly the outline bug this prevents.
// No tree reaches it today (rich text inside a FAQ answer tops out at h6).

export type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/** The element for a heading at `depth` (1 = the document title). */
export function headingTag(depth: number): HeadingTag {
  if (!Number.isInteger(depth) || depth < 1 || depth > 6)
    throw new RangeError(`no heading element for depth ${depth}`);
  return `h${depth}` as HeadingTag;
}

/** Depth of a top-level block's own title, right under the document title. */
export const BLOCK_DEPTH = 2;
