// The scripts a public page may carry (ADR 009 rule 4: no client framework on a content page):
// a form's proof-of-work module (brief form-intake § D2.3) and the lightbox of an image that opens
// larger, both plain modules from the site's own origin. One list, so a spec that counts
// the other scripts on a page does not spell it again.
// Rejected: each spec naming the files it expects, which drifted into four copies of one selector.

export const PUBLIC_SCRIPTS = ['/_form/proof.js', '/_image/lightbox.js'] as const;

/** Every script element on a page that is not one of `PUBLIC_SCRIPTS`. */
export const OTHER_SCRIPTS = `script:not(${PUBLIC_SCRIPTS.map((s) => `[src="${s}"]`).join(', ')})`;
