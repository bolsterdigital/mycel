// A public action's hover transition, sampled at five points: the CSS transitions on the element
// are paused once they run and set to 0, 25, 50, 75 and 100 % of their duration, and each sample
// reads the computed colours (also as hex through a canvas, which resolves `color-mix`), the
// text decoration and the lift (`translate`, MY-279). The spec judges the samples; this only
// reads them. Moved out of public-site.spec.ts, whose byte budget is full.
// Rejected: a wall-clock wait between samples (a busy runner finishes a 200 ms transition first).

import type { Locator } from '@playwright/test';

export interface ActionSample {
  fg: string;
  bg: string;
  fgHex: string;
  bgHex: string;
  decoration: string;
  translate: string;
  animations: number;
}

/** Hover `action` and sample its transition; the caller has moved the pointer away first. */
export async function sampleHover(action: Locator): Promise<ActionSample[]> {
  // Pause at transition start, so a busy runner cannot finish the fade before the test reads it.
  // No product duration or wall-clock wait is changed.
  await action.evaluate((el) =>
    el.addEventListener(
      'transitionrun',
      () => {
        for (const animation of el.getAnimations()) animation.pause();
      },
      { once: true }
    )
  );
  await action.hover();
  return action.evaluate(async (el) => {
    const animations = el.getAnimations();
    await Promise.all(animations.map((a) => a.ready));
    for (const a of animations) a.pause();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const hex = (colour: string) => {
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 1, 1);
      return (
        '#' +
        [...ctx.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((n) => n.toString(16).padStart(2, '0'))
          .join('')
      );
    };
    return [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
      for (const a of animations) a.currentTime = Number(a.effect!.getTiming().duration) * fraction;
      const css = getComputedStyle(el);
      return {
        fg: css.color,
        bg: css.backgroundColor,
        fgHex: hex(css.color),
        bgHex: hex(css.backgroundColor),
        decoration: css.textDecorationLine,
        translate: css.translate,
        animations: animations.length,
      };
    });
  });
}
