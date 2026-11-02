// The block forms and assist worker share one lossless Markdown grammar.
// Rejected: a web-only parser that translation could silently diverge from. Pasted plain text is
// another job, reading what was written elsewhere; WritingSurface.svelte keeps its own reader
// for it (ADR 020 rule 9).
export { canonicalRichText, fromMarkdown, toMarkdown } from '@mycel/core';
export type { MarkdownError, MarkdownResult } from '@mycel/core';
