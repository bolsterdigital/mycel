// UI copy for the web front (ADR 007 rule 1): public chrome and the operator admin. Domain messages (validation,
// mail) live in @mycel/core's catalogs; content (labels, consent text) lives on the documents.
//
// The strings live in one module per area under ./en (and ./nl), merged here, so `UiKey` stays
// one closed union derived from English and every caller keeps importing from this file. Rejected:
// one file per language (it reached the 200 KB `repo-size` limit, and nearly every PR
// touched it), raising that limit (the catalogue keeps growing with each feature) and shortening
// copy to fit (the words are chosen for the reader, not for a byte count). A new string goes into
// the area of the screen that shows it; `catalog.test.ts` refuses a key declared in two areas.

import { admin } from './en/admin.js';
import { audience } from './en/audience.js';
import { blocks } from './en/blocks.js';
import { content } from './en/content.js';
import { giving } from './en/giving.js';
import { media } from './en/media.js';
import { publicSite } from './en/public.js';
import { site } from './en/site.js';

/** The areas in merge order; a key in two of them would be silently overwritten by the spread. */
export const enAreas = [admin, content, blocks, site, media, audience, giving, publicSite];

export const en = {
  ...admin,
  ...content,
  ...blocks,
  ...site,
  ...media,
  ...audience,
  ...giving,
  ...publicSite,
} as const;

export type UiKey = keyof typeof en;
