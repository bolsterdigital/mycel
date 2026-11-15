// Stable synthetic references shared by block examples and their render/seed fixtures.
// Rejected: per-renderer ids, which would leave new examples unresolved.
import { exampleId } from '../../util/ids.js';

/** Example ids: the renderer's resolver fixtures (#8c) map these to a form, an item and images. */
export const EXAMPLE_IDS = {
  form: exampleId(0xf001),
  item: exampleId(0xc001),
  image: exampleId(0xd001),
  portrait: exampleId(0xd002),
  document: exampleId(0xd003),
  audio: exampleId(0xd004),
  campaign: exampleId(0xc1),
} as const;
