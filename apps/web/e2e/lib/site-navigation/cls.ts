// Cumulative layout shift of a page load, read from the browser's own buffered `layout-shift`
// entries, so a header that moves while it loads (the enhancement measuring the bar, a logo
// without dimensions, a font that fails) is caught where it happens.
// Rejected: a Lighthouse run per cell (lab audits belong to the frontend quality cycle and exceed
// the test budget) and comparing the header's box before and after, which misses a shift that has
// settled by the time the test looks.
import type { Page } from '@playwright/test';

/** The CLS limit of `docs/architecture/frontend-quality.md`. */
export const CLS_LIMIT = 0.1;

/**
 * The summed `value` of every layout shift since navigation that did not follow input, with the
 * shifted nodes for diagnosis. Call it after load (and after any enhancement under test) and
 * before the test itself resizes text, focuses or clicks. With `scripts`, two frames pass first, so
 * a shift from the last script task is reported; a page with scripts disabled runs no frame
 * callback, and a shift from loading has been reported by the time its load event fired.
 */
export function loadLayoutShift(page: Page, scripts: boolean) {
  return page.evaluate(async (scripts) => {
    await document.fonts.ready;
    if (scripts)
      await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)));
    const observer = new PerformanceObserver(() => {});
    // `buffered` hands over the entries from before this call; takeRecords reads them at once,
    // without a timer, which a page with scripts disabled would not run.
    observer.observe({ type: 'layout-shift', buffered: true });
    const entries = observer.takeRecords() as (PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
      sources?: { node?: Node | null }[];
    })[];
    observer.disconnect();
    const shifts = entries
      .filter((entry) => !entry.hadRecentInput)
      .map((entry) => ({
        value: entry.value,
        at: Math.round(entry.startTime),
        sources: (entry.sources ?? []).map((source) =>
          source.node instanceof Element
            ? `${source.node.localName}${source.node.className ? `.${String(source.node.className).trim().replace(/\s+/g, '.')}` : ''}`
            : (source.node?.nodeName ?? '?')
        ),
      }));
    return { value: shifts.reduce((sum, shift) => sum + shift.value, 0), shifts };
  }, scripts);
}
