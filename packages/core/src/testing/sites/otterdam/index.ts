// Otterdam (MY-264): a fictional charity for the otters of the Rotterdam region, as one site
// definition. `seedSite` puts it in a tenant; `packages/api/src/runtime/seed-site.ts` runs it
// against a database and prints a manifest of what is where. The realistic layer reads as a real
// organisation; the test layer (`tests.ts`) is recognisable as a test and exhaustive per axis.
// `otterdam.test.ts` fails when a block type or variant is missing, so the site stays complete as
// features are added.

import type { BlockInput } from '../../../content/blocks.js';
import type { NavigationDocument } from '../../../navigation/model.js';
import { block, say } from '../rich.js';
import type { SiteDefinition, SiteRefs } from '../runner.js';
import { OTTERDAM_ARTICLES } from './articles.js';
import { OTTERDAM_MEDIA } from './media.js';
import { OTTERDAM_PAGES } from './pages.js';
import { OTTERDAM_FORMS, OTTERDAM_GROUPS, OTTERDAM_PEOPLE, OTTERDAM_SECTIONS } from './register.js';
import { OTTERDAM_TESTS } from './tests.js';

export { OTTERDAM_PHOTOS, PODCAST_BASE64, reportPdf } from './media.js';

/** "Steun ons": a saved pattern (ADR 012 rule 8), and the same blocks where it was used. */
export const supportUs = (r: SiteRefs): BlockInput[] => [
  block('cta', {
    variant: 'card',
    title: { nl: 'Steun ons werk' },
    body: { nl: 'Met een gift of als vrijwilliger help je de otter in en om de stad.' },
    actions: [
      { label: { nl: 'Neem contact op' }, target: { kind: 'item', itemId: r.item('contact') } },
    ],
    width: 'content',
    align: 'center',
  }),
  say({ nl: 'Elke bijdrage telt, groot of klein.' }),
];

/** Where the pattern was used: the last blocks of these items. */
const USES = ['jaarverslag', 'podcast', 'najaarstelling'];

const navigation = (r: SiteRefs): NavigationDocument => ({
  menus: [
    {
      id: 'main',
      name: 'Hoofdmenu',
      nodes: [
        { id: 'over', kind: 'link', target: { kind: 'content', itemId: r.item('over-ons') } },
        { id: 'nieuws', kind: 'link', target: { kind: 'content', itemId: r.item('nieuws') } },
        { id: 'agenda', kind: 'link', target: { kind: 'content', itemId: r.item('evenementen') } },
        {
          id: 'dossiers',
          kind: 'group',
          label: { nl: 'Dossiers', en: 'Topics' },
          children: [
            {
              id: 'verkeer',
              kind: 'link',
              target: { kind: 'content', itemId: r.item('dossier-verkeer') },
            },
            {
              id: 'water',
              kind: 'link',
              target: { kind: 'content', itemId: r.item('dossier-water') },
            },
            {
              id: 'tijdlijn',
              kind: 'link',
              target: { kind: 'content', itemId: r.item('tijdlijn') },
            },
          ],
        },
        { id: 'contact', kind: 'link', target: { kind: 'content', itemId: r.item('contact') } },
        { id: 'zoeken', kind: 'link', target: { kind: 'system', page: 'search' } },
      ],
    },
    {
      id: 'acties',
      name: 'Acties',
      nodes: [
        {
          id: 'teken',
          kind: 'link',
          label: { nl: 'Teken de petitie', en: 'Sign the petition' },
          target: { kind: 'content', itemId: r.item('petitie') },
        },
      ],
    },
    {
      id: 'voet-over',
      name: 'Voet: over Otterdam',
      nodes: [
        { id: 'v-team', kind: 'link', target: { kind: 'content', itemId: r.item('team') } },
        { id: 'v-partners', kind: 'link', target: { kind: 'content', itemId: r.item('partners') } },
        {
          id: 'v-jaarverslag',
          kind: 'link',
          target: { kind: 'content', itemId: r.item('jaarverslag') },
        },
        { id: 'v-faq', kind: 'link', target: { kind: 'content', itemId: r.item('faq') } },
      ],
    },
    {
      id: 'voet-luister',
      name: 'Voet: luister en volg',
      nodes: [
        { id: 'v-podcast', kind: 'link', target: { kind: 'content', itemId: r.item('podcast') } },
        {
          id: 'v-bluesky',
          kind: 'link',
          label: { nl: 'Volg ons op Bluesky', en: 'Follow us on Bluesky' },
          target: { kind: 'url', href: 'https://bsky.app/profile/otterdam.example' },
        },
        {
          id: 'v-home',
          kind: 'link',
          label: { nl: 'Voorpagina', en: 'Home' },
          target: { kind: 'system', page: 'home' },
        },
      ],
    },
  ],
  placements: {
    main: { menuId: 'main', bar: ['over', 'nieuws', 'agenda', 'dossiers', 'contact'] },
    actions: { menuId: 'acties' },
    footer: [
      { menuId: 'voet-over', title: { nl: 'Over Otterdam', en: 'About Otterdam' } },
      { menuId: 'voet-luister', title: { nl: 'Luister en volg', en: 'Listen and follow' } },
    ],
    legal: null,
  },
});

const items = [...OTTERDAM_PAGES, ...OTTERDAM_ARTICLES, ...OTTERDAM_TESTS].map((item) =>
  USES.includes(item.key)
    ? {
        ...item,
        document: (r: SiteRefs) => {
          const doc = item.document(r);
          return { ...doc, blocks: [...doc.blocks, ...supportUs(r)] } as typeof doc;
        },
      }
    : item
);

export const OTTERDAM: SiteDefinition = {
  slug: 'otterdam',
  name: 'Otterdam',
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  media: OTTERDAM_MEDIA,
  people: OTTERDAM_PEOPLE,
  groups: OTTERDAM_GROUPS,
  sections: OTTERDAM_SECTIONS,
  forms: OTTERDAM_FORMS,
  items,
  patterns: [
    {
      key: 'steun-ons',
      name: { nl: 'Steun ons-blok', en: 'Support us block' },
      intendedType: 'page',
      blocks: supportUs,
    },
  ],
  campaigns: [
    {
      key: 'vistrappen',
      kind: 'petition',
      landing: 'petitie',
      form: 'petitie',
      goal: { target: 2500, milestones: [] },
    },
  ],
  navigation,
};
