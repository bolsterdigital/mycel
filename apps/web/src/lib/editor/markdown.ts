// The editor and assist worker share one lossless Markdown grammar.
// Rejected: a web-only parser that translation could silently diverge from.
export { canonicalRichText, fromMarkdown, toMarkdown } from '@mycel/core';
export type { MarkdownError, MarkdownResult } from '@mycel/core';
