// The two Playwright projects (playwright.config.ts): `no-js` proves a page works without a
// script, `a11y` runs with JavaScript and is where axe, layout measurements and enhancements
// are checked. A spec asks which one it is in through these two names, so the project name is
// spelled once.
// Rejected: a third project per measurement kind, which would run every flow once more.

import { test } from '@playwright/test';

/** Whether the current test runs in the `a11y` project, with JavaScript on. */
export const isA11y = (): boolean => test.info().project.name === 'a11y';

/** Skips the current test outside the `a11y` project; `reason` says what needs the script. */
export const onlyA11y = (reason = 'runs with JavaScript, in the a11y project'): void =>
  test.skip(!isA11y(), reason);

// The scripts a public page may carry (ADR 009 rule 4: no client framework on a content page):
// a form's proof-of-work module (brief form-intake § D2.3), the lightbox of an image that opens
// larger, the site navigation's enhancement (ADR 036 rule 12), the "read more" of a full
// campaign card's long text (ADR 038 amendment), the floating pairs between pages (MY-269), a
// managed video playing in the page after its press and a media article's read-along (MY-305),
// all plain modules from the site's own origin. One list, so a spec that counts the other scripts
// on a page does not spell it again.
// Rejected: each spec naming the files it expects, which drifted into four copies of one selector.

export const NAVIGATION_SCRIPT = '/_site/navigation.js';
/** The floating pairs between pages (MY-269 PR 2), in `<head>` while the theme's transitions
 *  are on, which they are in every e2e theme. */
export const TRANSITIONS_SCRIPT = '/_site/transitions.js';

export const PUBLIC_SCRIPTS = [
  '/_form/proof.js',
  '/_form/conditions.js',
  '/_image/lightbox.js',
  NAVIGATION_SCRIPT,
  '/_site/campaign-body.js',
  '/_site/article-initial.js',
  '/_site/embed.js',
  '/_site/managed-video.js',
  '/_site/read-along.js',
  TRANSITIONS_SCRIPT,
] as const;

/** Unexpected executable scripts; application/ld+json is an inert data block. */
export const OTHER_SCRIPTS = `script:not([type="application/ld+json"]):not(${PUBLIC_SCRIPTS.map((s) => `[src="${s}"]`).join(', ')})`;
