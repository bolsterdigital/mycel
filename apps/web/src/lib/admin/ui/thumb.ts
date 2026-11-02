// Every admin thumbnail comes from one route and is shown at one of three sizes, so an image
// reserves the same room wherever that use recurs. Rejected: width and height as attributes per
// screen, where the same use can drift apart between two screens without any check noticing.

/** A medium's admin thumbnail; `base` is the tenant's admin path. */
export const thumbPath = (base: string, mediaId: string): string =>
  `${base}/media/${mediaId}/thumb`;

// Write these out as width= and height=, never spread them on the <img>: for a spread Svelte's
// server output adds inline onload and onerror attributes, which the admin's CSP refuses.
export const THUMB = {
  /** Beside a line of text: a table row, an inherited value. */
  row: { width: 48, height: 48 },
  /** A choice in the media picker. */
  choice: { width: 160, height: 120 },
  /** A card in the media library. */
  card: { width: 320, height: 240 },
} as const;
