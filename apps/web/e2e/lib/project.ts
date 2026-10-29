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
