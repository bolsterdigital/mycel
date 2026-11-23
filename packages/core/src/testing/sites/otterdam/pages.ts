// Otterdam's pages: what a real small charity would have. The home page, about, contact and the
// petition are in Dutch and English; the rest is Dutch only, as on most sites of this size. Every
// custom block has a paragraph before and after it (Jaap, P185-79), so a reader judges blocks
// in the flow of a page, not stacked.

import { block, h, heading, href, p, rich, say, text, to, ul } from '../rich.js';
import type { ItemDef, SiteRefs } from '../runner.js';
import { galleryImage, headerImage, image } from './media.js';

const NL = ['nl'];
const NL_EN = ['nl', 'en'];

const page = (title: Record<string, string>, locales = NL) => ({
  type: 'page' as const,
  title,
  defaultLocale: 'nl',
  locales,
});

const overview = (props: Record<string, unknown>) =>
  block('overview', {
    source: 'article',
    sectionId: null,
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
    ...props,
  });

export const OTTERDAM_PAGES: ItemDef[] = [
  {
    key: 'home',
    slug: 'index',
    document: (r) => ({
      ...page({ nl: 'Otterdam', en: 'Otterdam' }, NL_EN),
      ...headerImage(r, 'kijken', NL_EN),
      lead: {
        nl: 'De otter is terug in de Maasdelta. Wij zorgen dat hij in en om Rotterdam kan blijven: met onderzoek, veilige oversteekplaatsen en schoon water.',
        en: 'The otter is back in the Maas delta. We make sure it can stay in and around Rotterdam: with research, safe crossings and clean water.',
      },
      blocks: [
        text({
          nl: [
            p(
              'Sinds 2019 telt Otterdam sporen, praat met waterbeheerders en zoekt samen met vissers en scholen naar plekken waar de otter verdwijnt. Dit is ons nieuwste werk.'
            ),
          ],
          en: [
            p(
              'Since 2019 Otterdam has counted tracks, talked to water managers and looked, together with anglers and schools, for the places where otters disappear. This is our latest work.'
            ),
          ],
        }),
        overview({ limit: '6', layout: 'cards' }),
        text({
          nl: [
            p(
              'Onze grootste zorg is het verkeer: de meeste dode otters vinden we langs wegen waar een beek onder door gaat. Daarom vragen we om veilige vistrappen en faunapassages.'
            ),
          ],
          en: [
            p(
              'Our biggest worry is traffic: most dead otters are found along roads where a stream passes underneath. That is why we ask for safe fish passes and wildlife crossings.'
            ),
          ],
        }),
        block('campaign-card', {
          campaignId: r.campaign('vistrappen'),
          variant: 'full',
          width: 'wide',
        }),
        text({
          nl: [p('Liever zelf op pad? Kom mee naar een excursie of help bij een opruimactie.')],
          en: [p('Rather go out yourself? Join an excursion or help at a clean-up.')],
        }),
        overview({
          source: 'event',
          when: 'upcoming',
          order: 'oldest',
          limit: '3',
          layout: 'list',
          width: 'content',
        }),
        text({
          nl: [p('Elke maand een korte brief over wat we zagen, deden en nog willen doen.')],
          en: [p('A short letter every month about what we saw, did and still want to do.')],
        }),
        block('signup-form', { formId: r.form('nieuwsbrief') }),
        text({
          nl: [p('Je kunt je altijd weer afmelden, met één klik onderaan elke brief.')],
          en: [p('You can always unsubscribe, with one click at the bottom of every letter.')],
        }),
      ],
    }),
  },
  {
    key: 'over-ons',
    slug: 'over-ons',
    document: (r) => ({
      ...page({ nl: 'Over ons', en: 'About us' }, NL_EN),
      ...headerImage(r, 'familie', NL_EN),
      lead: {
        nl: 'Otterdam is een kleine stichting met een grote achterban: zes mensen in dienst en ruim tweehonderd vrijwilligers.',
        en: 'Otterdam is a small foundation with a large following: six staff and more than two hundred volunteers.',
      },
      blocks: [
        text({
          nl: [
            h(2, 'Waarom de otter'),
            p(
              'De otter verdween in 1988 uit Nederland. Na de herintroductie in 2002 breidt hij zich langzaam uit, en sinds 2017 zien we sporen in de Biesbosch, langs de Oude Maas en zelfs in de Rotterdamse singels.'
            ),
            p(
              'Een otter heeft schoon water, genoeg vis en rustige oevers nodig. Waar het met de otter goed gaat, gaat het ook goed met de rest van het water.'
            ),
          ],
          en: [
            h(2, 'Why the otter'),
            p(
              'The otter disappeared from the Netherlands in 1988. Since it was reintroduced in 2002 it has slowly spread, and since 2017 we have seen tracks in the Biesbosch, along the Oude Maas and even in the canals of Rotterdam.'
            ),
            p(
              'An otter needs clean water, enough fish and quiet banks. Where the otter does well, so does the rest of the water.'
            ),
          ],
        }),
        image(r, 'panorama', { layout: 'wide', locales: NL_EN, credit: true }),
        text({
          nl: [
            h(2, 'Wat we doen'),
            ul(
              'Tellen: vrijwilligers zoeken elk voorjaar en najaar naar sporen en spraints.',
              'Oplossen: we wijzen de gevaarlijke plekken aan en denken mee over een oplossing.',
              'Vertellen: op scholen, in de podcast en op deze site.'
            ),
          ],
          en: [
            h(2, 'What we do'),
            ul(
              'Counting: every spring and autumn volunteers look for tracks and spraints.',
              'Solving: we point out the dangerous places and help think of a fix.',
              'Telling: at schools, in the podcast and on this site.'
            ),
          ],
        }),
        block('quote', {
          text: {
            nl: 'Een otter in de stad is geen wonder. Het is het bewijs dat het water weer leeft.',
            en: 'An otter in the city is not a miracle. It is proof that the water is alive again.',
          },
          attribution: { name: 'Anouk de Ruiter', role: { nl: 'directeur', en: 'director' } },
          variant: 'pullquote',
          width: 'wide',
        }),
        text({
          nl: [
            p(
              'Het bestuur bestaat uit twee mensen; de raad van toezicht houdt een oogje in het zeil.'
            ),
          ],
          en: [p('The board has two members; the supervisory board keeps an eye on things.')],
        }),
        block('people-grid', {
          source: 'group',
          groupId: r.group('bestuur'),
          people: [],
          columns: '2',
          showRole: true,
          showBio: true,
          showContact: true,
        }),
        text({
          nl: [
            p('Meer over ons werk staat in ', to('het jaarverslag', r.item('jaarverslag')), '.'),
          ],
          en: [
            p('More about our work is in ', to('the annual report', r.item('jaarverslag')), '.'),
          ],
        }),
      ],
    }),
  },
  {
    key: 'team',
    slug: 'team',
    document: (r) => ({
      ...page({ nl: 'Ons team' }),
      lead: { nl: 'Zes mensen, één doel: een stad waar de otter kan blijven.' },
      blocks: [
        say({
          nl: 'Iedereen in het team is ook gewoon te mailen. Zie je een otter, laat het Joris weten.',
        }),
        block('people-grid', {
          source: 'group',
          groupId: r.group('team'),
          people: [],
          columns: '3',
          showRole: true,
          showBio: true,
          showContact: false,
        }),
        say({ nl: 'Daarnaast helpen ruim tweehonderd vrijwilligers bij tellingen en acties.' }),
      ],
    }),
  },
  {
    key: 'partners',
    slug: 'partners',
    document: (r) => ({
      ...page({ nl: 'Partners' }),
      lead: { nl: 'We werken samen met organisaties die het water net zo goed kennen als wij.' },
      blocks: [
        say({ nl: 'Zonder deze drie partners zouden we de helft van onze waarnemingen missen.' }),
        block('people-grid', {
          source: 'selection',
          groupId: null,
          people: [
            { personId: r.person('natte-natuur') },
            { personId: r.person('hengelaars') },
            { personId: r.person('leerlingen') },
          ],
          columns: '3',
          showRole: false,
          showBio: true,
          showContact: true,
        }),
        say({ nl: 'Wil je met je organisatie partner worden? Neem contact met ons op.' }),
      ],
    }),
  },
  {
    key: 'contact',
    slug: 'contact',
    document: (r) => ({
      ...page({ nl: 'Contact', en: 'Contact' }, NL_EN),
      lead: {
        nl: 'Een vraag, een waarneming of een idee? We lezen alles en antwoorden binnen een week.',
        en: 'A question, a sighting or an idea? We read everything and reply within a week.',
      },
      blocks: [
        text({
          nl: [
            p(
              'Zag je een dode otter langs de weg? Bel dan liever direct de dierenambulance en mail ons daarna een foto en de plek.'
            ),
          ],
          en: [
            p(
              'Found a dead otter by the road? Call the animal ambulance first, then e-mail us a photo and the place.'
            ),
          ],
        }),
        block('form', { formId: r.form('contact'), variant: 'card', width: 'content' }),
        text({
          nl: [
            p(
              'Liever mailen? Dat kan via ',
              href('info@otterdam.example', 'mailto:info@otterdam.example'),
              '.'
            ),
          ],
          en: [
            p(
              'Rather e-mail? Write to ',
              href('info@otterdam.example', 'mailto:info@otterdam.example'),
              '.'
            ),
          ],
        }),
      ],
    }),
  },
  {
    key: 'petitie',
    slug: 'petitie-veilige-vistrappen',
    // The landing page of the petition campaign (ADR 038): the campaign layout shows kind,
    // count and form from the campaign, so the title does not repeat "Petitie" and the page
    // places no form block (rule 6). The text is a petition's own: what we note, what we ask.
    document: (r) => ({
      ...page(
        { nl: 'Veilige vistrappen voor de otter', en: 'Safe fish passes for the otter' },
        NL_EN
      ),
      ...headerImage(r, 'zandbank', NL_EN),
      lead: {
        nl: 'Vraag de waterbeheerders in de regio om elke nieuwe vistrap ook veilig te maken voor de otter.',
        en: 'Ask the water managers in the region to make every new fish pass safe for otters too.',
      },
      blocks: [
        text({
          nl: [
            p(
              'Aan de dijkgraven en het dagelijks bestuur van de waterschappen in de regio Otterdam.'
            ),
          ],
          en: [p('To the dike reeves and executive boards of the water boards around Otterdam.')],
        }),
        heading({ nl: 'Wij constateren', en: 'We note' }),
        text({
          nl: [
            p(
              'Een vistrap helpt vissen een stuw over. Maar een otter die de vis volgt, belandt vaak op de weg ernaast. Sinds 2020 zijn in onze regio minstens elf otters doodgereden bij een stuw of gemaal.'
            ),
            p(
              'Bij de meeste nieuwe vistrappen is aan de otter niet gedacht, terwijl een looprichel onder de brug of een faunabuis langs de stuw weinig kost en levens redt.'
            ),
          ],
          en: [
            p(
              'A fish pass helps fish over a weir. But an otter following the fish often ends up on the road next to it. Since 2020 at least eleven otters have been killed by traffic at a weir or pumping station in our region.'
            ),
            p(
              'Most new fish passes are built without the otter in mind, while a ledge under the bridge or a wildlife pipe beside the weir costs little and saves lives.'
            ),
          ],
        }),
        heading({ nl: 'En verzoeken', en: 'And ask' }),
        text({
          nl: [
            ul(
              'bij elke nieuwe of vernieuwde vistrap een otterpassage aan te leggen;',
              'de tien gevaarlijkste stuwen uit de telling van Otterdam binnen twee jaar aan te passen;',
              'elk jaar te melden hoeveel otters bij kunstwerken zijn gevonden.'
            ),
            p('Je handtekening telt zodra je hem bevestigt via de mail die je krijgt.'),
          ],
          en: [
            ul(
              'to build an otter passage at every new or renewed fish pass;',
              'to adapt the ten most dangerous weirs in Otterdam’s count within two years;',
              'to report every year how many otters were found at water structures.'
            ),
            p('Your signature counts once you confirm it through the e-mail you receive.'),
          ],
        }),
      ],
    }),
  },
  {
    key: 'evenementen',
    slug: 'evenementen',
    document: () => ({
      ...page({ nl: 'Evenementen' }),
      lead: { nl: 'Excursies, lezingen en opruimacties: kom mee.' },
      blocks: [
        say({ nl: 'Binnenkort:' }),
        overview({
          source: 'event',
          when: 'upcoming',
          order: 'oldest',
          limit: '12',
          layout: 'cards',
        }),
        say({ nl: 'Eerder gedaan:' }),
        overview({
          source: 'event',
          when: 'past',
          order: 'newest',
          limit: '6',
          layout: 'list',
          width: 'content',
        }),
        say({ nl: 'Alle evenementen zijn gratis, tenzij er iets anders bij staat.' }),
      ],
    }),
  },
  {
    // Every campaign of each kind (MY-292): three indexes that fill themselves, so a new petition
    // shows here without anyone editing this page.
    key: 'doe-mee',
    slug: 'doe-mee',
    document: () => ({
      ...page({ nl: 'Doe mee' }),
      lead: { nl: 'Teken, meld je aan of geef: alle acties van Otterdam op één plek.' },
      blocks: [
        heading({ nl: 'Petities' }),
        say({ nl: 'Met je handtekening vraag je het waterschap om actie.' }),
        overview({ source: 'campaign', campaignKind: 'petition' }),
        heading({ nl: 'Aanmelden' }),
        say({ nl: 'Meld je aan voor een telling of een excursie.' }),
        overview({ source: 'campaign', campaignKind: 'signup' }),
        heading({ nl: 'Inzamelingen' }),
        say({ nl: 'Elke gift gaat naar onderzoek en veilige oversteekplaatsen.' }),
        overview({ source: 'campaign', campaignKind: 'fundraiser' }),
        say({ nl: 'Een gesloten actie blijft hier staan, met de eindstand.' }),
      ],
    }),
  },
  {
    key: 'excursie',
    slug: 'excursie-biesbosch',
    document: (r) => ({
      ...page({ nl: 'Excursie: sporen zoeken in de Biesbosch' }),
      profile: 'event' as const,
      event: {
        startsAt: '2026-12-13T10:00',
        endsAt: '2026-12-13T13:00',
        location: { nl: 'Bezoekerscentrum (fictief), Biesboschweg 1, Otterdam' },
      },
      ...headerImage(r, 'sporen'),
      lead: {
        nl: 'Drie uur wandelen met Joris langs de kreken, op zoek naar pootafdrukken en spraints.',
      },
      blocks: [
        text({
          nl: [
            p(
              'Neem laarzen mee en kleding die vies mag worden. Kinderen vanaf acht jaar zijn welkom.'
            ),
            ul(
              'Verzamelen om 10.00 uur bij het bezoekerscentrum.',
              'Terug rond 13.00 uur.',
              'Maximaal twintig deelnemers.'
            ),
          ],
        }),
      ],
    }),
  },
  {
    key: 'lezing',
    slug: 'lezing-otters-in-de-stad',
    document: () => ({
      ...page({ nl: 'Lezing: otters in de stad' }),
      profile: 'event' as const,
      event: {
        startsAt: '2027-01-22T19:30',
        endsAt: '2027-01-22T21:00',
        location: { nl: 'Wijkcentrum De Kreek (fictief), Otterdam' },
        onlineUrl: 'https://otterdam.example/live',
      },
      lead: {
        nl: 'Anouk vertelt hoe de otter de stad in kwam, en wat de stad kan doen om hem te houden.',
      },
      blocks: [say({ nl: 'Ter plekke of online te volgen. Na afloop is er tijd voor vragen.' })],
    }),
  },
  {
    key: 'opruimactie',
    slug: 'opruimactie-oude-maas',
    document: (r) => ({
      ...page({ nl: 'Opruimactie langs de Oude Maas' }),
      profile: 'event' as const,
      event: {
        startsAt: '2026-10-04T09:30',
        endsAt: '2026-10-04T12:30',
        location: { nl: 'Veerstoep (fictief), Oude Maasdijk, Otterdam' },
      },
      ...headerImage(r, 'oever'),
      lead: { nl: 'Met 46 vrijwilligers haalden we 312 kilo zwerfvuil uit de oevers.' },
      blocks: [
        say({ nl: 'Dank aan iedereen die meedeed, en aan Hengelclub De Snoek voor de koffie.' }),
      ],
    }),
  },
  {
    key: 'dossier-verkeer',
    slug: 'otters-en-verkeer',
    document: (r) => ({
      ...page({ nl: 'Otters en verkeer' }),
      profile: 'dossier' as const,
      ...headerImage(r, 'oever'),
      lead: {
        nl: 'Verkeer is de grootste doodsoorzaak van de otter. Alles wat we erover schreven, op één plek.',
      },
      blocks: [
        say({
          nl: 'Bijna zeven op de tien dode otters die we vinden, liggen langs een weg. Hier lees je waarom, en wat eraan te doen is.',
        }),
        overview({ dossierId: r.item('dossier-verkeer'), limit: '12', layout: 'cards' }),
        say({ nl: 'Zelf een gevaarlijke plek gezien? Meld hem via het contactformulier.' }),
      ],
    }),
  },
  {
    key: 'dossier-water',
    slug: 'schoon-water',
    document: (r) => ({
      ...page({ nl: 'Schoon water' }),
      profile: 'dossier' as const,
      ...headerImage(r, 'panorama'),
      lead: { nl: 'Geen otter zonder vis, geen vis zonder schoon water.' },
      blocks: [
        say({ nl: 'Over waterkwaliteit, PFAS, zwerfvuil en waarom een otter er last van heeft.' }),
        overview({ dossierId: r.item('dossier-water'), limit: '12', layout: 'cards' }),
        say({ nl: 'Deze stukken worden bijgewerkt zodra er nieuwe metingen zijn.' }),
      ],
    }),
  },
  {
    key: 'jaarverslag',
    slug: 'jaarverslag-2025',
    document: (r) => ({
      ...page({ nl: 'Jaarverslag 2025' }),
      lead: { nl: 'Wat we in 2025 deden, wat het kostte en wat het opleverde.' },
      blocks: [
        text({
          nl: [
            p(
              'In 2025 deden 214 vrijwilligers mee aan de tellingen. Samen met de waterbeheerders kwamen er zes faunapassages bij. De inkomsten kwamen voor 61 procent uit giften van particulieren.'
            ),
          ],
        }),
        block('file-download', {
          title: { nl: 'Download' },
          files: [{ fileId: r.media('jaarverslag'), name: { nl: 'Jaarverslag 2025 (pdf)' } }],
        }),
        say({ nl: 'Een gedrukt exemplaar? Vraag het aan via het contactformulier.' }),
      ],
    }),
  },
  {
    key: 'podcast',
    slug: 'podcast',
    document: (r) => ({
      ...page({ nl: 'Podcast: Onder water' }),
      lead: { nl: 'Lotte praat elke maand met iemand die de otter van dichtbij kent.' },
      blocks: [
        say({
          nl: 'Aflevering 1: Joris over het tellen van spraints, en waarom dat minder vies is dan het klinkt.',
        }),
        block('audio', {
          title: { nl: 'Aflevering 1: tellen in de Biesbosch' },
          fileId: r.media('podcast'),
          transcript: {
            nl: 'Lotte: Joris, wat is een spraint eigenlijk?\nJoris: Een otterkeutel. Hij ruikt naar jasmijnthee en vis, en hij vertelt ons precies wat de otter at.',
          },
        }),
        say({ nl: 'Volgende maand: Samira over de petitie voor veilige vistrappen.' }),
      ],
    }),
  },
  {
    key: 'tijdlijn',
    slug: 'tijdlijn',
    document: () => ({
      ...page({ nl: 'De otter in Rotterdam, een tijdlijn' }),
      lead: { nl: 'Van verdwenen tot terug in de singels.' },
      blocks: [
        say({ nl: 'De belangrijkste momenten, van oud naar nieuw.' }),
        block('timeline', {
          title: { nl: 'Mijlpalen' },
          order: 'oldest',
          events: [
            { date: '1988-01-01', title: { nl: 'Laatste otter in Nederland gevonden' } },
            { date: '2002-06-01', title: { nl: 'Herintroductie in de Weerribben' } },
            { date: '2017-03-12', title: { nl: 'Eerste sporen in de Biesbosch' } },
            {
              date: '2019-09-01',
              title: { nl: 'Otterdam opgericht' },
              body: { nl: 'Met vijf vrijwilligers en één fiets.' },
            },
            { date: '2024-05-20', title: { nl: 'Eerste otter in de Rotterdamse singels' } },
            { date: '2025-11-03', title: { nl: 'Zes nieuwe faunapassages' } },
            // Still to come, so the timeline shows its "Now" line (MY-278).
            {
              date: '2027-04-12',
              title: { nl: 'Voorjaarstelling 2027' },
              body: { nl: 'Alle 42 routes opnieuw gelopen; aanmelden kan vanaf maart.' },
            },
            { date: '2028-06-01', title: { nl: 'Otterpassage onder de A16 open' } },
          ],
        }),
        say({
          nl: 'De data voor 2017 komen uit openbare bronnen; de rest uit onze eigen tellingen.',
        }),
      ],
    }),
  },
  {
    key: 'faq',
    slug: 'veelgestelde-vragen',
    document: (r) => ({
      ...page({ nl: 'Veelgestelde vragen' }),
      lead: { nl: 'Over otters, over ons en over wat jij kunt doen.' },
      blocks: [
        say({ nl: 'Staat je vraag er niet bij, stel hem dan via het contactformulier.' }),
        block('faq', {
          variant: 'accordion',
          title: { nl: 'Vragen en antwoorden' },
          width: 'content',
          entries: [
            {
              question: { nl: 'Is een otter gevaarlijk?' },
              answer: rich({
                nl: [
                  p(
                    'Nee. Een otter is schuw en gaat mensen uit de weg. Houd wel afstand en laat je hond aan de lijn.'
                  ),
                ],
              }),
            },
            {
              question: { nl: 'Hoe herken ik een otterspoor?' },
              answer: rich({
                nl: [
                  p(
                    'Vijf tenen met zwemvliezen, en vaak een glijspoor. Lees ',
                    to('ons stuk over sporen', r.item('sporen-herkennen')),
                    '.'
                  ),
                ],
              }),
            },
            {
              question: { nl: 'Wat doet Otterdam met mijn gift?' },
              answer: rich({
                nl: [
                  p('Ruim driekwart gaat naar onderzoek en faunapassages. Zie het jaarverslag.'),
                ],
              }),
            },
          ],
        }),
        say({ nl: 'Antwoorden worden bijgewerkt als er iets verandert.' }),
      ],
    }),
  },
  {
    key: 'nieuws',
    slug: 'nieuws',
    document: () => ({
      ...page({ nl: 'Nieuws' }),
      lead: { nl: 'Alles wat we schreven, het nieuwste eerst.' },
      blocks: [
        say({ nl: 'Kies hieronder een bericht, of blader verder in het archief.' }),
        overview({ limit: '12', layout: 'cards', archive: true }),
        say({ nl: 'Ook een tip voor een bericht? Laat het Lotte weten.' }),
      ],
    }),
  },
];

/** A gallery of the four most-used photos, for the articles. */
export const otterGallery = (r: SiteRefs) =>
  block('gallery', {
    images: [
      galleryImage(r, 'familie'),
      galleryImage(r, 'drinkt'),
      galleryImage(r, 'glijbaan'),
      galleryImage(r, 'portret'),
    ],
    variant: 'grid',
    width: 'wide',
  });
