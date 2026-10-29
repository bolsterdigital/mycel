// One image a media picker offers (brief media-picker): shared by the server that lists them and
// the component that renders them, so neither invents its own shape.
export interface MediaChoice {
  id: string;
  /** The filename, the name an editor recognises. */
  label: string;
  /** Whether `media/<id>/thumb` exists; a failed or document upload has none. */
  thumb: boolean;
}
