import type { Page } from '@playwright/test';
import { execSync } from 'node:child_process';
export async function diag(page: Page, text: string) {
  console.log(
    'DIAG fc',
    execSync(
      'fc-match sans-serif; fc-match system-ui; fc-match sans-serif:bold; fc-list : family | sort -u | head -30'
    ).toString()
  );
  console.log(
    'DIAG',
    text,
    JSON.stringify(
      await page.evaluate(() => {
        const h = document.querySelector('#ui-overview-title')!;
        const t = document.querySelector('.ui-overview-head .ui-hint-toggle');
        const r = (e: Element | null | undefined) => e && JSON.stringify(e.getBoundingClientRect());
        return {
          font: getComputedStyle(h).fontFamily,
          size: getComputedStyle(h).fontSize,
          h: r(h),
          t: r(t),
          head: r(h.parentElement),
          bar: r(h.parentElement?.parentElement),
          toggles: [...document.querySelectorAll('.ui-hint-toggle')].map(
            (e) =>
              `${e.parentElement?.className}:${e.getBoundingClientRect().width}x${e.getBoundingClientRect().height}`
          ),
        };
      })
    )
  );
}
