// Markup this application rendered itself, for `{@html}` in a component that a hydrated page can
// mount later: Svelte then assigns the value to `innerHTML`, and under Trusted Types
// (vite.config.ts) that takes a typed value. The policy passes the string on, so what makes it safe
// is what the callers pass: the output of the rich-text renderer or a fixed string, never input.
// Rejected: a sanitiser here, a second opinion on markup the renderer already builds from a closed
// schema, and running it over every revision on screen.

type TrustedTypePolicyFactory = {
  createPolicy(
    name: string,
    rules: { createHTML(html: string): string }
  ): { createHTML(html: string): string };
};

const factory = (globalThis as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
const policy = factory?.createPolicy('mycel-rendered-html', { createHTML: (html) => html });

/** On the server and in a browser without Trusted Types this is the string itself. */
export const renderedHtml = (html: string): string => policy?.createHTML(html) ?? html;
