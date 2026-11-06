// A credit as one line of text: what Markdown and the admin's block card show, in the same words
// as the page's Credit.svelte gives a screen reader. Rejected: each consumer wording it itself
// (the admin card and the Markdown already drifted once from the page).

import { creditKind, type CreditKind, type MediaCredit } from '@mycel/core';
import type { UiKey } from '../../i18n/en.js';

/** The word per kind of image, `{name}` still in it: 'Foto: {name}'. */
export const creditWords = (t: (key: UiKey) => string): Record<CreditKind, string> => ({
  photo: t('block.credit.photo'),
  illustration: t('block.credit.illustration'),
  other: t('block.credit.other'),
});

export const creditText = (c: MediaCredit, words: Record<CreditKind, string>): string =>
  [
    c.work ? `${c.work.title}, ${c.work.maker}` : null,
    c.photographer ? words[creditKind(c)].replace('{name}', () => c.photographer ?? '') : null,
  ]
    .filter(Boolean)
    .join(' · ');
