// Speculation rules in a real browser (checklist item speculation-rules): hold the pointer on a
// link, click it, and read how the navigation was delivered. `deliveryType` on the navigation
// entry says `navigational-prefetch` only when the document came from a fetch ahead; a click on a
// link the rules leave out arrives as an ordinary load, so the same measurement can fail.
// Rejected: a proxy in front of the server to read `sec-purpose: prefetch`, which proves the fetch
// but not that the browser used it for the click.

import type { Page } from '@playwright/test';

// Chromium's moderate eagerness acts after 200 ms on a link; the rest is margin, so a left-out
// link has had its chance when the click comes.
const HOLD_MS = 800;

/** Open `from`, hold the pointer on a link to `href`, click, report if it was fetched ahead. */
export async function arrivesFetchedAhead(
  page: Page,
  from: string,
  href: string,
  attributes: Record<string, string> = {}
): Promise<boolean> {
  await page.goto(from);
  // The corpus pages need not link to each other. The document rules see an added link like any
  // other.
  const link = await page.evaluateHandle(
    ({ href, attributes }) => {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = 'speculation probe';
      for (const [name, value] of Object.entries(attributes)) a.setAttribute(name, value);
      document.body.append(a);
      return a;
    },
    { href, attributes }
  );
  await link.asElement()!.scrollIntoViewIfNeeded();
  await link.asElement()!.hover();
  await page.waitForTimeout(HOLD_MS);
  await link.asElement()!.click({ noWaitAfter: true });
  await page.waitForURL((url) => url.href.endsWith(href));
  return page.evaluate(
    () =>
      (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)
        .deliveryType === 'navigational-prefetch'
  );
}
