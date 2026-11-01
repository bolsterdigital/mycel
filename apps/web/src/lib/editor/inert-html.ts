// Pasted HTML has to become a document before anything can clean it, and under Trusted Types
// (vite.config.ts) a DOMParser takes no plain string. The policy passes the string on unchanged,
// which is safe for this one use: a parsed document runs no script and loads nothing, and the
// caller removes what it does not want and hands the rest to the schema. So the policy stays
// private to this module. Rejected: sanitising here as well, which would be a second list of what
// is allowed next to the schema.

type TrustedTypePolicyFactory = {
  createPolicy(
    name: string,
    rules: { createHTML(html: string): string }
  ): { createHTML(html: string): string };
};

const factory = (globalThis as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
const policy = factory?.createPolicy('mycel-inert-html', { createHTML: (html) => html });

/** A document that runs nothing, for reading only; never put its markup back through a sink. */
export function parseInert(html: string): Document {
  return new DOMParser().parseFromString(policy?.createHTML(html) ?? html, 'text/html');
}

/**
 * Removes the line breaks between tags, as TipTap does for a string: with whitespace preserved
 * they would each become a paragraph of their own.
 */
export function withoutLineBreakNodes<T extends Element>(element: T): T {
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && /^(\n\s\s|\n)$/.test(child.nodeValue ?? ''))
      element.removeChild(child);
    else if (child instanceof Element) withoutLineBreakNodes(child);
  }
  return element;
}
