// Otterdam's test pages: recognisable as tests (title "Test: …", slug `test-…`), each one axis
// exhaustively, for a tester who wants to see every layout and variant once. "All blocks" is
// built from the variant lists of `BLOCK_DEFINITIONS`: one block per value of the longest list,
// cycling the shorter ones, so a new value shows up here without anyone editing this file, and a
// new block type fails `otterdam.test.ts` until it has a base here. No theoretical edge cases:
// only what an ordinary editor runs into.

import type { BlockInput } from '../../../content/blocks.js';
import { BLOCK_DEFINITIONS } from '../../../content/block-types.js';
import { INSERTABLE_BLOCK_TYPES } from '../../../content/blocks.js';
import type { L } from '../rich.js';
import {
  block,
  bold,
  boldItalic,
  br,
  code,
  h,
  heading,
  href,
  italic,
  lang,
  note,
  ol,
  p,
  rich,
  say,
  text,
  to,
  ul,
} from '../rich.js';
import type { ItemDef, SiteRefs } from '../runner.js';
import type { OtterPhotoKey } from './media.js';
import { OTTERDAM_PHOTOS, galleryImage, headerImage, image } from './media.js';

const page = (title: string) => ({
  type: 'page' as const,
  title: { nl: title },
  defaultLocale: 'nl',
  locales: ['nl'],
});
const nl = (s: string): L => ({ nl: s });
const between = (s: string) => say(nl(s));

/** One block of each type with every required prop, before a variant is applied. */
const BASES: Record<string, (r: SiteRefs) => Record<string, unknown>> = {
  heading: () => ({ text: nl('Een tussenkop') }),
  'signup-form': (r) => ({ formId: r.form('nieuwsbrief') }),
  'rich-text': () => ({
    content: rich({ nl: [p('Een alinea met ', bold('vet'), ' en ', italic('cursief'), '.')] }),
  }),
  image: (r) => image(r, 'portret').props as Record<string, unknown>,
  cta: (r) => ({
    title: nl('Doe mee met de telling'),
    body: nl('Twee uur per seizoen is genoeg.'),
    actions: [
      { label: nl('Meld je aan'), target: { kind: 'item', itemId: r.item('contact') } },
      { label: nl('Meer weten'), target: { kind: 'url', url: 'https://otterdam.example/tellen' } },
    ],
  }),
  'people-grid': (r) => ({
    groupId: r.group('team'),
    people: [
      { personId: r.person('anouk') },
      { personId: r.person('joris') },
      { personId: r.person('lotte') },
    ],
    showRole: true,
    showBio: false,
    showContact: false,
  }),
  cards: (r) => ({
    cards: [
      {
        title: nl('Tellen'),
        body: nl('Zoek sporen langs een vaste route.'),
        actions: [
          { label: nl('Lees meer'), target: { kind: 'item', itemId: r.item('spraints-tellen') } },
        ],
      },
      {
        title: nl('Opruimen'),
        body: nl('Help de oevers schoon te houden.'),
        actions: [
          { label: nl('Evenementen'), target: { kind: 'item', itemId: r.item('evenementen') } },
        ],
      },
      {
        title: nl('Vertellen'),
        actions: [{ label: nl('Podcast'), target: { kind: 'item', itemId: r.item('podcast') } }],
      },
    ],
  }),
  'file-download': (r) => ({
    title: nl('Downloads'),
    files: [{ fileId: r.media('jaarverslag'), name: nl('Jaarverslag 2025') }],
  }),
  gallery: (r) => ({
    images: (['familie', 'drinkt', 'oever', 'sporen', 'portret'] as const).map((k) =>
      galleryImage(r, k)
    ),
  }),
  audio: (r) => ({ title: nl('Podcast, aflevering 1'), fileId: r.media('podcast') }),
  timeline: () => ({
    title: nl('Drie momenten'),
    events: [
      { date: '2019-09-01', title: nl('Oprichting') },
      { date: '2024-05-20', title: nl('Otter in de singels') },
      { date: '2026-11-12', title: nl('Najaarstelling') },
    ],
  }),
  callout: () => ({
    title: nl('Let op'),
    body: rich({ nl: [p('Houd afstand van een otter met jongen.')] }),
  }),
  faq: () => ({
    title: nl('Twee vragen'),
    entries: [
      {
        question: nl('Bijt een otter?'),
        answer: rich({ nl: [p('Alleen als hij in het nauw zit.')] }),
      },
      {
        question: nl('Hoe oud wordt een otter?'),
        answer: rich({ nl: [p('In het wild zelden ouder dan tien jaar.')] }),
      },
    ],
  }),
  quote: () => ({
    text: nl('Waar de otter zwemt, leeft het water.'),
    attribution: { name: 'Joris van der Meer', role: nl('ecoloog') },
  }),
  'video-embed': () => ({ videoId: 'aqz-KE-bpKQ', title: nl('Testvideo') }),
  form: (r) => ({ formId: r.form('contact') }),
  'campaign-card': (r) => ({ campaignId: r.campaign('vistrappen') }),
  overview: () => ({
    sectionId: null,
    dossierId: null,
    tags: [],
    limit: '3',
    pinned: [],
    archive: false,
  }),
};

/** Video ids per provider: the base has YouTube's. */
const VIDEO_IDS: Record<string, string> = { youtube: 'aqz-KE-bpKQ', vimeo: '76979871' };
/** One form per variant: a page holds a form once. */
const FORM_FOR: Record<string, string> = { default: 'contact', card: 'nieuwsbrief' };

const label = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

/** The block types in the order of the definitions, without the ones "All blocks" leaves out. */
export const ALL_BLOCKS_TYPES = INSERTABLE_BLOCK_TYPES.filter((t) => t !== 'paywall');

function allBlocks(r: SiteRefs): BlockInput[] {
  const out: BlockInput[] = [
    between('Elk bloktype, elke variant: telkens een kop met wat je ziet, het blok en een zin.'),
  ];
  for (const type of ALL_BLOCKS_TYPES) {
    const base = BASES[type];
    if (!base) throw new Error(`Otterdam "Alle blokken" has no base for block type ${type}`);
    const variants = Object.entries(BLOCK_DEFINITIONS[type].variants) as [
      string,
      readonly string[],
    ][];
    const rounds = Math.max(1, ...variants.map(([, values]) => values.length));
    for (let i = 0; i < rounds; i++) {
      const chosen = Object.fromEntries(
        variants.map(([key, values]) => [key, values[i % values.length]!])
      );
      const props = { ...base(r), ...chosen };
      if (type === 'video-embed') props['videoId'] = VIDEO_IDS[chosen['provider']!]!;
      if (type === 'form') props['formId'] = r.form(FORM_FOR[chosen['variant']!]!);
      if (type === 'people-grid' && chosen['source'] === 'selection') props['groupId'] = null;
      if (type === 'people-grid' && chosen['source'] === 'group') props['people'] = [];
      out.push(heading(nl(`${type}${variants.length ? `: ${label(chosen)}` : ''}`)));
      out.push(block(type as keyof typeof BLOCK_DEFINITIONS, props));
      // Two rich-text blocks in a row are one block (`content.blocks.adjacent-rich-text`).
      if (type !== 'rich-text')
        out.push(between(`Einde van ${type}${variants.length ? ` (${label(chosen)})` : ''}.`));
    }
  }
  return out;
}

const LAYOUTS = ['content', 'wide', 'full', 'float-left', 'float-right'] as const;

function images(r: SiteRefs): BlockInput[] {
  const out: BlockInput[] = [
    between(
      'Eerst elke opmaak met dezelfde foto, dan elke verhouding, dan met en zonder onderschrift en maker.'
    ),
  ];
  for (const layout of LAYOUTS)
    out.push(
      heading(nl(`Opmaak: ${layout}`)),
      image(r, 'portret', { layout }),
      text({
        nl: [
          p(`Tekst na een afbeelding in ${layout}. `.repeat(6).trim()),
          p('Een tweede alinea, zodat een zwevend beeld iets heeft om naast te staan.'),
        ],
      })
    );
  for (const photo of OTTERDAM_PHOTOS) {
    const ratio = (photo.width / photo.height).toFixed(2);
    out.push(
      heading(nl(`Verhouding ${ratio}: ${photo.filename}`)),
      image(r, photo.key as OtterPhotoKey, { layout: 'wide' }),
      between(`De foto is ${photo.width} bij ${photo.height} pixels.`)
    );
  }
  out.push(
    heading(nl('Zonder onderschrift')),
    image(r, 'oever', { caption: false }),
    between('Hierboven geen onderschrift.'),
    heading(nl('Met onderschrift en maker')),
    image(r, 'oever', { credit: true }),
    between('Hierboven onderschrift en maker.'),
    heading(nl('Galerij: raster en rij')),
    block('gallery', {
      images: OTTERDAM_PHOTOS.map((ph) => galleryImage(r, ph.key as OtterPhotoKey)),
      variant: 'grid',
      width: 'wide',
    }),
    between('Tien foto’s in een raster.'),
    block('gallery', {
      images: (['familie', 'kijken', 'panorama'] as const).map((k) => galleryImage(r, k)),
      variant: 'row',
      width: 'full',
    }),
    between('Drie foto’s in een rij.'),
    heading(nl('Mensen met en zonder foto')),
    block('people-grid', {
      source: 'group',
      groupId: r.group('team'),
      people: [],
      columns: '4',
      showRole: true,
      showBio: false,
      showContact: false,
    }),
    between('Pieter en Ravi hebben geen foto.')
  );
  return out;
}

const formatting = (r: SiteRefs): BlockInput[] => [
  text({
    nl: [
      p(
        'Gewone tekst, ',
        bold('vet'),
        ', ',
        italic('cursief'),
        ', ',
        boldItalic('vet en cursief'),
        ' en ',
        code('code'),
        '.'
      ),
      p(
        'Een link naar ',
        to('een artikel', r.item('sporen-herkennen')),
        ', naar ',
        to('een pagina', r.item('over-ons')),
        ', naar ',
        href('een externe site', 'https://example.org/'),
        ' en naar ',
        href('een mailadres', 'mailto:info@otterdam.example'),
        '.'
      ),
      p(
        'Een zin met een ',
        note('voetnoot', 'Dit is de tekst van de voetnoot.'),
        ' en nog ',
        note('een', 'Een tweede voetnoot.'),
        '.'
      ),
      p('Een woord in een andere taal: ', lang('otter', 'en'), ', zoals de Engelsen zeggen.'),
      p('Een regel', br, 'met een harde regelafbreking.'),
      h(2, 'Kop van niveau 2'),
      p('Tekst onder een kop van niveau 2.'),
      h(3, 'Kop van niveau 3'),
      p('Tekst onder een kop van niveau 3.'),
      ul(
        'Een opsomming',
        [p('Met een geneste lijst'), ul([p('En nog een niveau dieper'), ul('Derde niveau')])],
        'Laatste punt'
      ),
      ol('Eerste stap', 'Tweede stap', 'Derde stap'),
      p('Een lange alinea. '.repeat(40).trim()),
    ],
  }),
];

const combinations = (r: SiteRefs): BlockInput[] => [
  block('cta', {
    variant: 'band',
    title: nl('Een oproep direct onder de kop'),
    actions: [{ label: nl('Naar contact'), target: { kind: 'item', itemId: r.item('contact') } }],
    width: 'wide',
    align: 'start',
  }),
  image(r, 'portret', { layout: 'float-left' }),
  block('faq', {
    variant: 'list',
    title: nl('Vragen na een zwevend beeld'),
    width: 'content',
    entries: [
      {
        question: nl('Loopt dit goed door?'),
        answer: rich({ nl: [p('Dat is wat je hier test.')] }),
      },
    ],
  }),
  block('gallery', {
    images: (['familie', 'drinkt'] as const).map((k) => galleryImage(r, k)),
    variant: 'grid',
    width: 'content',
  }),
  block('callout', {
    variant: 'warning',
    title: nl('Een melding tussen twee galerijen'),
    body: rich({ nl: [p('Zonder tekst ertussen.')] }),
  }),
  block('gallery', {
    images: (['oever', 'sporen'] as const).map((k) => galleryImage(r, k)),
    variant: 'row',
    width: 'content',
  }),
  block('quote', {
    text: nl('Een citaat direct na een galerij.'),
    attribution: { name: 'Lotte Visser' },
    variant: 'pullquote',
    width: 'content',
  }),
  block('campaign-card', {
    campaignId: r.campaign('vistrappen'),
    variant: 'compact',
    width: 'content',
  }),
  block('cta', {
    variant: 'card',
    title: nl('Twee oproepen achter elkaar'),
    actions: [{ label: nl('Petitie'), target: { kind: 'item', itemId: r.item('petitie') } }],
    width: 'content',
    align: 'center',
  }),
  between('Pas hier weer een gewone alinea.'),
];

const LONG_TITLE =
  'Test: een heel lange titel van een artikel over de otterbeschermingsfaunapassagesubsidieaanvraagformulieren die een redacteur zomaar kan typen, om te zien hoe kaarten en koppen afbreken';

const edges = (r: SiteRefs): BlockInput[] => [
  text({
    nl: [
      p(
        'Een lang samengesteld woord in lopende tekst: otterbeschermingsfaunapassagesubsidieaanvraagformulieren. Het moet afbreken zonder dat de pagina horizontaal gaat schuiven.'
      ),
    ],
  }),
  heading(nl('Overzicht van de testrubriek: een artikel met een lange titel en een zonder beeld')),
  block('overview', {
    source: 'article',
    sectionId: r.section('test'),
    dossierId: null,
    tags: [],
    when: 'upcoming',
    campaignKind: 'petition',
    order: 'newest',
    limit: '6',
    pinned: [],
    layout: 'cards',
    archive: false,
    width: 'wide',
  }),
  between('Hierboven: kaarten met en zonder beeld naast elkaar.'),
  heading(nl('Overzicht van een lege rubriek')),
  block('overview', {
    source: 'article',
    sectionId: r.section('leeg'),
    dossierId: null,
    tags: [],
    when: 'upcoming',
    campaignKind: 'petition',
    order: 'newest',
    limit: '6',
    pinned: [],
    layout: 'cards',
    archive: false,
    width: 'wide',
  }),
  between('Hierboven: een rubriek zonder artikelen.'),
];

const testPage = (
  key: string,
  slug: string,
  title: string,
  lead: string,
  blocks: (r: SiteRefs) => BlockInput[],
  photo?: OtterPhotoKey
): ItemDef => ({
  key,
  slug,
  document: (r) => ({
    ...page(title),
    ...(photo && headerImage(r, photo)),
    lead: nl(lead),
    blocks: blocks(r),
  }),
});

export const OTTERDAM_TESTS: ItemDef[] = [
  testPage(
    'test-afbeeldingen',
    'test-afbeeldingen',
    'Test: afbeeldingen',
    'Elke afbeeldingsopmaak, elke verhouding, met en zonder onderschrift.',
    images,
    'familie'
  ),
  testPage(
    'test-blokken',
    'test-alle-blokken',
    'Test: alle blokken',
    'Elk bloktype in elke variant, één keer, in vaste volgorde.',
    allBlocks
  ),
  testPage(
    'test-opmaak',
    'test-tekstopmaak',
    'Test: tekstopmaak',
    'Koppen, lijsten, links, voetnoten en elke opmaak die de editor kent.',
    formatting
  ),
  testPage(
    'test-combinaties',
    'test-combinaties',
    'Test: combinaties',
    'Blokken direct na elkaar, zonder tekst ertussen.',
    combinations
  ),
  testPage(
    'test-randen',
    'test-randen',
    'Test: randen',
    'Wat een gewone redacteur tegenkomt: lange woorden, lege rubrieken, kaarten zonder beeld.',
    edges
  ),
  {
    key: 'test-lange-titel',
    slug: 'test-lange-titel',
    publishedAt: '2024-12-01T09:00:00+01:00',
    document: (r) => ({
      type: 'article',
      title: { nl: LONG_TITLE },
      defaultLocale: 'nl',
      locales: ['nl'],
      ...headerImage(r, 'panorama'),
      lead: { nl: 'Een testartikel met een titel van bijna tweehonderd tekens.' },
      authorIds: [r.person('lotte')],
      sectionId: r.section('test'),
      tags: ['test'],
      blocks: [between('Alleen de titel is hier de test.')],
    }),
  },
  {
    key: 'test-zonder-beeld',
    slug: 'test-zonder-beeld',
    publishedAt: '2024-12-02T09:00:00+01:00',
    document: (r) => ({
      type: 'article',
      title: { nl: 'Test: artikel zonder beeld' },
      defaultLocale: 'nl',
      locales: ['nl'],
      lead: { nl: 'Geen hoofdbeeld en geen uitgelicht beeld: hoe ziet de kaart eruit?' },
      authorIds: [r.person('pieter')],
      sectionId: r.section('test'),
      tags: ['test'],
      blocks: [between('Dit artikel heeft bewust geen beeld.')],
    }),
  },
];

/** The test pages a custom block may follow another block on: they test exactly that. */
export const CROWDED_ON_PURPOSE = ['test-combinaties'];
