// The Dutch UI copy, one module per area under ./nl mirroring ./en (see en.ts for why).

import type { UiKey } from './en.js';
import { admin } from './nl/admin.js';
import { audience } from './nl/audience.js';
import { blocks } from './nl/blocks.js';
import { content } from './nl/content.js';
import { giving } from './nl/giving.js';
import { imports } from './nl/import.js';
import { media } from './nl/media.js';
import { publicSite } from './nl/public.js';
import { site } from './nl/site.js';

/** The areas in merge order; a key in two of them would be silently overwritten by the spread. */
export const nlAreas = [admin, content, blocks, site, media, audience, giving, imports, publicSite];

export const nl: Partial<Record<UiKey, string>> = {
  ...admin,
  ...content,
  ...blocks,
  ...site,
  ...media,
  ...audience,
  ...giving,
  ...imports,
  ...publicSite,
};
