// A page transition in progress (MY-269): while a cross-document view transition runs, its
// pseudo-element layer lies over the whole page and takes the hit test, so a raw mouse action
// right after a navigation (`page.mouse.click`, unlike a locator click, does not retry) lands on
// the transition instead of the element under it. Measured on the first build: a click on an
// overview card right after `page.goBack()` was lost 5 times in 5 with the rule, 0 in 5 without;
// the transition was already active when `goBack` returned and ended about 260 ms later.
// Polled from the test, not awaited in the page: the no-js project runs no animation frames or
// timers for an evaluated script, so a `requestAnimationFrame` or `waitForFunction` there hangs.
// Rejected: a fixed sleep, which is either too short on a loaded CI runner or slows every run,
// and turning the transitions off in e2e, which `expectChromeTransitions` demands are on.

import { expect, type Page } from '@playwright/test';

/** Resolves once the new page has painted and shows no view transition. Call it after a
 *  navigation and before the next raw mouse action. The paint keeps a transition that only
 *  starts at the page's first render (`pagereveal`) from being missed by checking too early. */
export async function transitionSettled(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            performance.getEntriesByType('paint').length > 0 &&
            !document.documentElement.matches(':active-view-transition')
        ),
      { message: 'the page transition ends', intervals: [20] }
    )
    .toBe(true);
}
