import type { MediaCredit } from '@mycel/core';

// One image a media picker offers (brief media-picker): shared by the server that lists them and
// the component that renders them, so neither invents its own shape.
export interface MediaChoice {
  id: string;
  /** The filename, the name an editor recognises. */
  label: string;
  /** Whether `media/<id>/thumb` exists; a failed or document upload has none. */
  thumb: boolean;
  /**
   * What a block card shows at rest (MY-110 A): a variant file at card scale for
   * `media/<id>/variant/<file>`, the pixel size for its aspect ratio, and the file's own caption
   * and credit, which a block inherits unless it overrides them. Absent for an image the
   * operator may not read or that is gone: the card then says so.
   */
  card?: {
    file: string;
    width: number;
    height: number;
    caption: Record<string, string>;
    credit: MediaCredit;
  } | null;
}
