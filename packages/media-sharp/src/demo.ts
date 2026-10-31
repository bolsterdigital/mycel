// Placeholder pictures for the dev seed's demo content: a diagonal gradient with a
// large label, as PNG, so a page shows landscape and portrait images without committing binary
// files. The SVG is built here from a label and two colours only, never from caller markup, and
// never reaches `media.upload` as SVG (which refuses it): only the rasterised PNG does.
// Rejected: photos in the repository (weight, and someone's rights) and solid fills without a
// label (two images of one colour are indistinguishable in the admin's media list).

import sharp from 'sharp';

export interface LabelImage {
  width: number;
  height: number;
  label: string;
  /** Gradient from the top left to the bottom right, as `#rrggbb`. */
  colors: readonly [string, string];
}

const escape = (text: string) => text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
const HEX = /^#[0-9a-f]{6}$/i;

/** PNG bytes of `width` by `height`: the gradient, the label and a small "demo" line. */
export async function renderLabelImage({
  width,
  height,
  label,
  colors,
}: LabelImage): Promise<Uint8Array> {
  if (!colors.every((c) => HEX.test(c))) throw new Error('colors must be #rrggbb');
  const size = Math.round(Math.min(width / Math.max(label.length * 0.62, 6), height / 6));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/>
</linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#ffffff"
 font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}">${escape(label)}</text>
<text x="50%" y="${height - Math.round(height / 12)}" text-anchor="middle" fill="#ffffff"
 fill-opacity="0.7" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(size / 3)}">Mycel demo</text>
</svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}
