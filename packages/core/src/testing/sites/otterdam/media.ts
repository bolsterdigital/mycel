// Otterdam's files: ten public-domain otter photographs (committed in
// `packages/api/demo-sites/otterdam/` with source and hash), a one-page annual report and a short
// sound for the podcast, both generated so they need no binary in the repo. Alt texts describe
// what is in the picture; captions say what Otterdam would say about it. The places in the
// captions are invented, as the organisation is.

import type { BlockInput } from '../../../content/blocks.js';
import { DEMO_SOUND_BASE64 } from '../../demo-sound.js';
import type { L } from '../rich.js';
import { block } from '../rich.js';
import type { MediaDef, SiteRefs } from '../runner.js';

export type OtterPhotoKey =
  | 'drinkt'
  | 'familie'
  | 'glijbaan'
  | 'oever'
  | 'portret'
  | 'sporen'
  | 'zandbank'
  | 'drijven'
  | 'kijken'
  | 'panorama';

export interface OtterPhoto {
  key: OtterPhotoKey;
  filename: string;
  width: number;
  height: number;
  photographer: string;
  /** The Commons page that states the licence. */
  source: string;
  alt: L;
  caption: L;
}

const commons = (file: string) => `https://commons.wikimedia.org/wiki/File:${file}`;

export const OTTERDAM_PHOTOS: readonly OtterPhoto[] = [
  {
    key: 'drinkt',
    filename: 'otter-drinkt.jpg',
    width: 1600,
    height: 1067,
    photographer: 'Josh Spice, National Park Service',
    source: commons('River_otter_takes_a_drink_from_Lamar_River_(49706304902).jpg'),
    alt: {
      nl: 'Een otter drinkt aan de rand van een rivier tussen sneeuwbanken',
      en: 'An otter drinks at the edge of a river between banks of snow',
    },
    caption: {
      nl: 'In strenge winters zoekt de otter het open water op.',
      en: 'In hard winters the otter looks for open water.',
    },
  },
  {
    key: 'familie',
    filename: 'otter-familie.jpg',
    width: 1600,
    height: 1067,
    photographer: 'Jacob W. Frank, National Park Service',
    source: commons('River_otter_family_on_the_Gibbon_River_(39489929815).jpg'),
    alt: {
      nl: 'Drie otters zwemmen tussen omgevallen takken onder een besneeuwde oever',
      en: 'Three otters swim among fallen branches below a snowy bank',
    },
    caption: {
      nl: 'Een moeder met twee jongen: de jongen blijven ruim een jaar bij haar.',
      en: 'A mother with two cubs: the young stay with her for over a year.',
    },
  },
  {
    key: 'glijbaan',
    filename: 'otter-glijbaan.jpg',
    width: 1600,
    height: 1067,
    photographer: 'Jacob W. Frank, National Park Service',
    source: commons('River_otter_slide_tracks_(41503563772).jpg'),
    alt: {
      nl: 'Glijsporen in de sneeuw lopen naar een donker wak in het ijs',
      en: 'Slide tracks in the snow lead to a dark hole in the ice',
    },
    caption: {
      nl: 'Glijsporen verraden een otter, ook als je hem zelf niet ziet.',
      en: 'Slide tracks give an otter away, even when you never see it.',
    },
  },
  {
    key: 'oever',
    filename: 'otter-oever.jpg',
    width: 1600,
    height: 1208,
    photographer: 'Kristine Sowl, U.S. Fish and Wildlife Service',
    source: commons('River_Otter_(13436617583).jpg'),
    alt: {
      nl: 'Een otter loopt over een besneeuwde oever met kale struiken',
      en: 'An otter walks along a snowy bank with bare shrubs',
    },
    caption: {
      nl: 'Otters leggen tot vijftien kilometer per nacht af, ook over land.',
      en: 'Otters travel up to fifteen kilometres a night, over land as well.',
    },
  },
  {
    key: 'portret',
    filename: 'otter-portret.jpg',
    width: 1200,
    height: 1200,
    photographer: 'Glacier National Park, National Park Service',
    source: commons('Northern_River_Otter_(Lontra_canadensis)_(48490226747).jpg'),
    alt: {
      nl: 'Een otter zit rechtop op een bemoste oever en kijkt omhoog',
      en: 'An otter sits upright on a mossy bank and looks up',
    },
    caption: {
      nl: 'Rechtop zitten om te kijken: typisch otter.',
      en: 'Sitting up to look around: typical otter.',
    },
  },
  {
    key: 'sporen',
    filename: 'otter-sporen.jpg',
    width: 1067,
    height: 1600,
    photographer: 'Courtney Celley, U.S. Fish and Wildlife Service',
    source: commons('River_Otter_Tracks_(27379170639).jpg'),
    alt: {
      nl: 'Pootafdrukken en een glijspoor lopen in een rechte lijn door de sneeuw',
      en: 'Paw prints and a slide run in a straight line through the snow',
    },
    caption: {
      nl: 'Vijf tenen met zwemvliezen: zo herken je een otterspoor.',
      en: 'Five webbed toes: that is how you recognise an otter track.',
    },
  },
  {
    key: 'zandbank',
    filename: 'otter-zandbank.jpg',
    width: 1600,
    height: 1200,
    photographer: 'Arches National Park, National Park Service',
    source: commons('Otter_in_lower_courthouse_wash_(30969022290).jpg'),
    alt: {
      nl: 'Een otter zwemt door troebel ondiep water langs een zandbank',
      en: 'An otter swims through murky shallow water along a sandbank',
    },
    caption: {
      nl: 'Ook in troebel water vindt de otter zijn vis, op de tast met zijn snorharen.',
      en: 'Even in murky water the otter finds its fish, by feel with its whiskers.',
    },
  },
  {
    key: 'drijven',
    filename: 'otters-drijven.jpg',
    width: 1400,
    height: 753,
    photographer: 'Lilian Carswell, U.S. Fish and Wildlife Service',
    source: commons('Sea_otter_float_(48749714078).jpg'),
    alt: {
      nl: 'Een groep zeeotters drijft dicht bij elkaar op blauw water',
      en: 'A group of sea otters floats close together on blue water',
    },
    caption: {
      nl: 'Zeeotters, verre familie van onze rivierotter, rusten in groepen.',
      en: 'Sea otters, distant relatives of our river otter, rest in groups.',
    },
  },
  {
    key: 'kijken',
    filename: 'otters-kijken.jpg',
    width: 1280,
    height: 720,
    photographer: 'Ted Narveson, U.S. Fish and Wildlife Service',
    source: commons('Usfws-river-otters-peeking-over-water.jpg'),
    alt: {
      nl: 'Drie otterkoppen steken boven het water uit en kijken in de camera',
      en: 'Three otter heads rise above the water and look into the camera',
    },
    caption: {
      nl: 'Nieuwsgierig, maar schuw: houd afstand en blijf stil.',
      en: 'Curious but shy: keep your distance and stay quiet.',
    },
  },
  {
    key: 'panorama',
    filename: 'otters-panorama.jpg',
    width: 1600,
    height: 799,
    photographer: 'Peter Pearsall, U.S. Fish and Wildlife Service',
    source: commons('USFWS_otters_(23221933714).jpg'),
    alt: {
      nl: 'Twee otters zwemmen in donker water tussen drijvend kroos',
      en: 'Two otters swim in dark water among floating duckweed',
    },
    caption: {
      nl: 'Schoon water met genoeg vis: meer heeft een otter niet nodig.',
      en: 'Clean water with enough fish: an otter needs little more.',
    },
  },
];

export const REPORT_FILENAME = 'otterdam-jaarverslag-2025.pdf';
export const PODCAST_FILENAME = 'otterdam-podcast-aflevering-1.mp3';

/** A one-page PDF with one line of text, written here so no binary is committed for it. */
export function reportPdf(): Uint8Array {
  const line = 'Otterdam jaarverslag 2025: 214 waarnemingen, 6 nieuwe faunapassages.';
  const stream = `BT /F1 14 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) pdf += `${String(at).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export const PODCAST_BASE64 = DEMO_SOUND_BASE64;

export const OTTERDAM_MEDIA: MediaDef[] = [
  ...OTTERDAM_PHOTOS.map((photo): MediaDef => ({
    key: photo.key,
    filename: photo.filename,
    contentType: 'image/jpeg',
    editorial: {
      caption: photo.caption,
      credit: { work: null, photographer: photo.photographer },
      source: photo.source,
      licence: { code: 'other', text: 'Publiek domein' },
    },
  })),
  { key: 'jaarverslag', filename: REPORT_FILENAME, contentType: 'application/pdf' },
  { key: 'podcast', filename: PODCAST_FILENAME, contentType: 'audio/mpeg' },
];

const photo = (key: OtterPhotoKey) => OTTERDAM_PHOTOS.find((p) => p.key === key)!;

/** Only the locales the item has: an `nl` item gets no English alt. */
const only = (value: L, locales: readonly string[]) =>
  Object.fromEntries(locales.map((l) => [l, value[l] ?? value['nl']!]));

export interface ImageOptions {
  layout?: 'content' | 'wide' | 'full' | 'float-left' | 'float-right';
  /** Show the photo's caption (default) or none. */
  caption?: boolean;
  /** Show the photographer under the image. */
  credit?: boolean;
  locales?: readonly string[];
}

/** An image block of an Otterdam photo, with its own alt text. */
export function image(r: SiteRefs, key: OtterPhotoKey, options: ImageOptions = {}): BlockInput {
  const locales = options.locales ?? ['nl'];
  const p = photo(key);
  return block('image', {
    mediaId: r.media(key),
    decorative: false,
    alt: only(p.alt, locales),
    ...(options.caption !== false && { caption: only(p.caption, locales) }),
    ...(options.credit && {
      credit: { work: null, photographer: p.photographer, kind: 'photo' },
    }),
    layout: options.layout ?? 'content',
  });
}

/** A gallery item of an Otterdam photo. */
export const galleryImage = (
  r: SiteRefs,
  key: OtterPhotoKey,
  locales: readonly string[] = ['nl']
) => ({
  mediaId: r.media(key),
  decorative: false,
  alt: only(photo(key).alt, locales),
  caption: only(photo(key).caption, locales),
});

/** The header image fields of a document: hero, its alt, and the same photo where it is featured. */
export const headerImage = (
  r: SiteRefs,
  key: OtterPhotoKey,
  locales: readonly string[] = ['nl']
) => ({
  heroImageId: r.media(key),
  heroAlt: only(photo(key).alt, locales),
});
