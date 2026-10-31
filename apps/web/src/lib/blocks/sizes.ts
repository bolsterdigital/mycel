// The `sizes` of a block image per layout, shared by the image block and the item's hero so both
// describe the same column. A float follows the container steps of base.css (brief 46C-1): half
// the reading column from 64rem, 40% of it from 40rem, the full width below. Measured on the probe
// theme at 65ch: a 734 px column gives a 367 px float at 1440 px (23rem) and 293 px at 768 px
// (18.5rem). Below the breakpoints every layout but `full` sits between two gutters of
// `min(1rem, 4vw)`, which `NARROW` says, at most a pixel under.
//
// Rejected: plain `100vw` below the breakpoints. It overshot a 359 px image on a 3x phone by one
// variant step (w1280, 77 KB, where w1080 is enough).

const NARROW = 'calc(100vw - 2rem)';
const FLOAT = `(min-width: 64rem) 23rem, (min-width: 40rem) 18.5rem, ${NARROW}`;

export const IMAGE_SIZES = {
  content: `(min-width: 48rem) 44rem, ${NARROW}`,
  wide: `(min-width: 72rem) 68rem, ${NARROW}`,
  full: '100vw',
  'float-left': FLOAT,
  'float-right': FLOAT,
} as const;

export type ImageLayout = keyof typeof IMAGE_SIZES;
