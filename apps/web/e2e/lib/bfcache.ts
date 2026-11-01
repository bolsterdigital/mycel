// Back/forward cache (checklist item bfcache): a visitor who follows a link and presses Back
// gets the page back from memory, scroll position and form input included, instead of a new
// request. Anything that makes a page ineligible (an unload handler, an open connection, a
// header the browser refuses) shows up as a reason in the DevTools protocol event
// `Page.backForwardCacheNotUsed`, which this helper collects next to the plain outcome.
// It needs its own browser: Playwright starts Chromium with `--disable-back-forward-cache`, and
// the headless shell it uses by default refuses the cache regardless
// (`BackForwardCacheDisabledForDelegate`, measured on Chromium 156). The full Chromium build
// that `playwright install chromium` also installs keeps it.
// Rejected: `performance.getEntriesByType('navigation')[0].notRestoredReasons`, which reports
// only `masked` in an automated browser, and a `pageshow` listener, which needs a script on a
// page that ships none.

import { chromium, type Browser, type Page } from '@playwright/test';

/** A Chromium that keeps the back/forward cache; close it when the test is done. */
export const bfcacheBrowser = (): Promise<Browser> =>
  chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });

export interface BfcacheOutcome {
  restored: boolean;
  /** Why the browser did not keep the page; empty when it was restored. */
  reasons: string[];
}

/**
 * Open `path`, go to `away`, go back, and report whether the first page came back from the
 * cache. A marker set on the page's window survives only a restore, not a new load.
 */
export async function bfcacheRestore(
  page: Page,
  path: string,
  away: string
): Promise<BfcacheOutcome> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  let reasons: string[] = [];
  cdp.on('Page.backForwardCacheNotUsed', (event) => {
    reasons = event.notRestoredExplanations.map((explanation) => explanation.reason);
  });
  await page.goto(path);
  await page.evaluate(() => {
    (window as { bfcacheMarker?: true }).bfcacheMarker = true;
  });
  await page.goto(away);
  // A restore fires no load event and Playwright sees no new lifecycle state, so wait for the
  // commit and give the protocol event, if any, a moment to arrive.
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForTimeout(500);
  const restored = await page.evaluate(
    () => (window as { bfcacheMarker?: true }).bfcacheMarker === true
  );
  await cdp.detach();
  return { restored, reasons };
}
