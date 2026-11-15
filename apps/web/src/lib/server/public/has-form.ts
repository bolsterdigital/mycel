// Whether a render model puts a form on the page, which makes the page `no-store` without an ETag
// (public-page.ts). Its own module so the resolver tests can ask it without the runtime.
import type { RenderModel } from '../../blocks/model.js';

/**
 * Whether the page renders a form. The render model is flat: a pattern is copied into the item
 * as plain blocks (content/patterns.ts), so there is no nesting left to walk.
 */
export function hasForm(model: RenderModel): boolean {
  return model.blocks.some(
    (b) => (b.type === 'form' || b.type === 'campaign-card') && b.form !== null
  );
}
