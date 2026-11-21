// Otterdam's articles: twenty, published between May 2025 and November 2026 (`publishedAt` is
// their first publication, ADR 012 rule 4), plus one draft and one scheduled. Between them they
// carry every article state a tester should see: the cover and the standard header, no image,
// a lead, footnotes, links to other items, two authors, tags, dossiers, members only with a
// paywall, an earlier revision, and an English translation that lags behind the Dutch.

import type { z } from 'zod';
import type { useCases } from '../../../use-cases.js';
import { block, bold, h, italic, note, ol, p, rich, say, text, to, ul } from '../rich.js';
import type { ItemDef, SiteRefs } from '../runner.js';
import type { OtterPhotoKey } from './media.js';
import { headerImage, image } from './media.js';
import { otterGallery } from './pages.js';

type Doc = Extract<z.input<typeof useCases.createItem.input>['document'], { type: 'article' }>;

interface ArticleSpec {
  key: string;
  slug: string;
  title: Record<string, string>;
  /** First publication, as an ISO date (09:00 Amsterdam is added). */
  date: string;
  section: string | null;
  authors: string[];
  tags?: string[];
  lead?: Record<string, string>;
  photo?: OtterPhotoKey;
  cover?: boolean;
  dossiers?: string[];
  locales?: string[];
  extra?: (r: SiteRefs) => Partial<Doc>;
  blocks(r: SiteRefs): Doc['blocks'];
}

const at = (date: string) => `${date}T09:00:00+01:00`;

function article(spec: ArticleSpec, item: Partial<ItemDef> = {}): ItemDef {
  const locales = spec.locales ?? ['nl'];
  return {
    key: spec.key,
    slug: spec.slug,
    ...(!item.status || item.status === 'published' ? { publishedAt: at(spec.date) } : {}),
    ...item,
    document: (r) => ({
      type: 'article',
      title: spec.title,
      defaultLocale: 'nl',
      locales,
      ...(spec.photo && headerImage(r, spec.photo, locales)),
      ...(spec.lead && { lead: spec.lead }),
      authorIds: spec.authors.map(r.person),
      sectionId: spec.section ? r.section(spec.section) : null,
      tags: spec.tags ?? [],
      ...(spec.cover && { presentation: { header: 'cover' as const } }),
      ...(spec.dossiers && { dossiers: spec.dossiers.map((d) => ({ itemId: r.item(d) })) }),
      ...spec.extra?.(r),
      blocks: spec.blocks(r),
    }),
  };
}

export const OTTERDAM_ARTICLES: ItemDef[] = [
  article({
    key: 'eerste-singel',
    slug: 'eerste-otter-in-de-singels',
    title: {
      nl: 'Eerste otter gezien in de Rotterdamse singels',
      en: 'First otter seen in the Rotterdam canals',
    },
    date: '2025-05-20',
    section: 'nieuws',
    authors: ['lotte'],
    tags: ['singels', 'waarneming'],
    photo: 'kijken',
    cover: true,
    locales: ['nl', 'en'],
    lead: {
      nl: 'Een hondenuitlater zag hem om half zes in de ochtend: een otter, midden in de stad.',
      en: 'A dog walker saw it at half past five in the morning: an otter, right in the middle of the city.',
    },
    blocks: () => [
      text({
        nl: [
          p(
            'De waarneming kwam binnen via het contactformulier, met een korrelige maar duidelijke foto. Joris ging dezelfde dag kijken en vond verse sporen onder de brug.'
          ),
          p('Het is de eerste bevestigde otter binnen de ring sinds de jaren zeventig.'),
        ],
        en: [
          p(
            'The sighting came in through the contact form, with a grainy but clear photo. Joris went to look the same day and found fresh tracks under the bridge.'
          ),
          p('It is the first confirmed otter inside the ring road since the seventies.'),
        ],
      }),
      block('quote', {
        text: {
          nl: 'Ik dacht eerst dat het een grote rat was. Toen dook hij.',
          en: 'At first I thought it was a big rat. Then it dived.',
        },
        attribution: { name: 'Ellen', role: { nl: 'hondenuitlater', en: 'dog walker' } },
        variant: 'blockquote',
        width: 'content',
      }),
      text({
        nl: [p('We houden de plek geheim, om de otter rust te gunnen.')],
        en: [p('We keep the place secret, to give the otter some peace.')],
      }),
    ],
  }),
  article({
    key: 'spraints-tellen',
    slug: 'zo-tellen-we-otters',
    title: { nl: 'Zo tellen we otters zonder ze te zien' },
    date: '2025-06-12',
    section: 'onderzoek',
    authors: ['joris'],
    tags: ['onderzoek', 'telling'],
    photo: 'zandbank',
    lead: { nl: 'Een otter laat zich zelden zien. Zijn keutels wel.' },
    blocks: () => [
      text({
        nl: [
          p(
            'Otters markeren hun gebied met ',
            note(
              'spraints',
              'Spraint: de Engelse vakterm voor een otterkeutel, die ook in Nederland wordt gebruikt.'
            ),
            ' op vaste plekken: een steen, een boomstronk, een richel onder een brug.'
          ),
          h(2, 'Wat we doen'),
          ol(
            'We lopen elk seizoen dezelfde route.',
            'Elke vondst krijgt een GPS-punt en een foto.',
            'Een deel gaat naar het lab voor DNA.'
          ),
          p(
            'Met DNA kunnen we ',
            note(
              'individuen onderscheiden',
              'Een individu herkennen we aan een vaste set van twaalf genetische markers.'
            ),
            ', en zo schatten hoeveel otters er zijn.'
          ),
        ],
      }),
    ],
  }),
  article({
    key: 'verkeersslachtoffers',
    slug: 'zeven-op-de-tien-dode-otters-liggen-langs-de-weg',
    title: { nl: 'Zeven op de tien dode otters liggen langs de weg' },
    date: '2025-07-03',
    section: 'onderzoek',
    authors: ['joris', 'samira'],
    tags: ['verkeer', 'faunapassage'],
    photo: 'oever',
    dossiers: ['dossier-verkeer'],
    lead: { nl: 'Onze analyse van vijf jaar vondsten laat zien waar het misgaat.' },
    blocks: (r) => [
      text({
        nl: [
          p(
            'Van de 38 dode otters die we sinds 2020 vonden, kwamen er 27 om in het verkeer. Bijna altijd op een plek waar een beek of sloot onder de weg door gaat.'
          ),
        ],
      }),
      block('callout', {
        variant: 'info',
        title: { nl: 'Wat is een faunapassage?' },
        body: rich({
          nl: [
            p(
              'Een looprichel of droge buis onder een weg, zodat dieren niet over het asfalt hoeven.'
            ),
          ],
        }),
      }),
      text({
        nl: [
          p(
            'In onze ',
            to('petitie', r.item('petitie')),
            ' vragen we om zo’n passage bij elke nieuwe vistrap.'
          ),
        ],
      }),
    ],
  }),
  article({
    key: 'zomer-excursie',
    slug: 'verslag-zomerexcursie',
    title: { nl: 'Verslag: zomerexcursie langs de kreken' },
    date: '2025-07-28',
    section: 'op-pad',
    authors: ['pieter'],
    tags: ['excursie', 'biesbosch'],
    photo: 'familie',
    lead: { nl: 'Dertig deelnemers, twee sporen en één ijsvogel.' },
    blocks: (r) => [
      text({
        nl: [
          p(
            'We vertrokken om negen uur met dertig mensen, van zes tot tachtig. Bij de tweede kreek vond een meisje van acht het eerste spoor.'
          ),
        ],
      }),
      otterGallery(r),
      text({ nl: [p('De volgende excursie staat al in de agenda.')] }),
    ],
  }),
  article({
    key: 'pfas',
    slug: 'pfas-in-otters',
    title: { nl: 'PFAS gevonden in otters uit de Maasdelta' },
    date: '2025-08-19',
    section: 'achtergrond',
    authors: ['joris'],
    tags: ['waterkwaliteit', 'pfas'],
    photo: 'panorama',
    dossiers: ['dossier-water'],
    lead: { nl: 'Wat het betekent, en wat het niet betekent.' },
    blocks: () => [
      text({
        nl: [
          p(
            'In de lever van vier verkeersslachtoffers vond het lab ',
            note('PFAS', 'PFAS: een groep van duizenden stoffen die moeilijk afbreken.'),
            ', in waarden die vergelijkbaar zijn met otters elders in Europa.'
          ),
          p(
            bold('Wat het betekent:'),
            ' de otter staat bovenaan de voedselketen en stapelt op wat in de vis zit.'
          ),
          p(
            bold('Wat het niet betekent:'),
            ' dat deze otters eraan doodgingen. Daarvoor is meer onderzoek nodig.'
          ),
        ],
      }),
    ],
  }),
  article({
    key: 'vistrap-kapelle',
    slug: 'vistrap-met-looprichel-geopend',
    title: { nl: 'Eerste vistrap met looprichel geopend' },
    date: '2025-09-09',
    section: 'campagnes',
    authors: ['samira'],
    tags: ['faunapassage', 'vistrap'],
    photo: 'drinkt',
    dossiers: ['dossier-verkeer'],
    lead: { nl: 'Een kleine richel van beton, een groot verschil.' },
    blocks: (r) => [
      text({
        nl: [
          p(
            'De waterbeheerder opende de vistrap in de Kreekweg met een looprichel aan beide kanten. Het idee kwam uit onze gesprekken van vorig jaar.'
          ),
        ],
      }),
      image(r, 'glijbaan', { layout: 'wide' }),
      text({ nl: [p('Binnen een maand vonden we de eerste sporen óp de richel.')] }),
    ],
  }),
  article({
    key: 'opruimen',
    slug: 'helpers-gezocht-voor-de-najaarsopruimactie',
    title: { nl: 'Helpers gezocht voor de najaarsopruimactie' },
    date: '2025-09-30',
    section: 'op-pad',
    authors: ['pieter'],
    tags: ['vrijwilligers', 'zwerfvuil'],
    lead: { nl: 'Handschoenen, grijpers en koffie liggen klaar.' },
    blocks: (r) => [
      text({
        nl: [
          p(
            'Op zaterdag gaan we met zoveel mogelijk mensen de oevers langs. Opgeven hoeft niet, maar helpt wel.'
          ),
        ],
      }),
      block('cta', {
        variant: 'band',
        title: { nl: 'Doe mee' },
        body: {
          nl: 'Meld je aan via het contactformulier, dan weten we hoeveel koffie we moeten zetten.',
        },
        actions: [
          {
            label: { nl: 'Naar het formulier' },
            target: { kind: 'item', itemId: r.item('contact') },
          },
        ],
        width: 'wide',
        align: 'center',
      }),
      text({ nl: [p('Kinderen zijn welkom onder begeleiding.')] }),
    ],
  }),
  article({
    key: 'sporen-herkennen',
    slug: 'otterspoor-herkennen',
    title: { nl: 'Zo herken je een otterspoor', en: 'How to recognise an otter track' },
    date: '2025-10-15',
    section: 'achtergrond',
    authors: ['joris'],
    tags: ['sporen'],
    photo: 'sporen',
    locales: ['nl', 'en'],
    lead: {
      nl: 'Vijf tenen, zwemvliezen en een glijspoor.',
      en: 'Five toes, webbed feet and a slide.',
    },
    blocks: (r) => [
      text({
        nl: [
          p(
            'Een otterspoor is ongeveer zes centimeter breed, met vijf tenen. In zachte modder zie je de zwemvliezen.'
          ),
          ul(
            'Vos: vier tenen, smaller spoor.',
            'Bever: groter, met een sleepspoor van de staart.',
            'Hond: vier tenen, nagels duidelijk zichtbaar.'
          ),
        ],
        en: [
          p(
            'An otter track is about six centimetres wide, with five toes. In soft mud you can see the webbing.'
          ),
          ul(
            'Fox: four toes, narrower track.',
            'Beaver: larger, with a drag mark from the tail.',
            'Dog: four toes, claws clearly visible.'
          ),
        ],
      }),
      image(r, 'glijbaan', { layout: 'float-right', locales: ['nl', 'en'] }),
      text({
        nl: [
          p(
            'Glijsporen zijn het mooiste bewijs: otters glijden graag van een oever het water in, ook voor de lol.'
          ),
          p('Twijfel je? Stuur een foto met iets erbij voor de schaal.'),
        ],
        en: [
          p(
            'Slides are the best proof: otters like to slide down a bank into the water, just for fun.'
          ),
          p('Not sure? Send a photo with something next to it for scale.'),
        ],
      }),
    ],
  }),
  article(
    {
      key: 'winter',
      slug: 'hoe-overleeft-een-otter-de-winter',
      title: {
        nl: 'Hoe overleeft een otter de winter?',
        en: 'How does an otter survive the winter?',
      },
      date: '2025-11-27',
      section: 'achtergrond',
      authors: ['lotte'],
      tags: ['winter'],
      photo: 'drinkt',
      cover: true,
      locales: ['nl', 'en'],
      lead: {
        nl: 'Geen speklaag, wel een vacht van een miljoen haren.',
        en: 'No blubber, but a coat of a million hairs.',
      },
      blocks: () => [
        text({
          nl: [
            p(
              'Een otter heeft geen vetlaag zoals een zeehond. Hij houdt het warm met een dikke vacht, waarin een laagje lucht blijft zitten.'
            ),
            p('Daarom poetst hij zich zo vaak: een vuile vacht isoleert niet.'),
          ],
          en: [
            p(
              'An otter has no fat layer as a seal has. It keeps warm with a dense coat that traps a layer of air.'
            ),
            p('That is why it grooms so often: a dirty coat does not insulate.'),
          ],
        }),
      ],
    },
    {
      // The English translation lags: it is published on the earlier revision below.
      earlier: (r) => [
        {
          type: 'article',
          title: {
            nl: 'Hoe overleeft een otter de winter?',
            en: 'How does an otter survive the winter?',
          },
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          ...headerImage(r, 'drinkt', ['nl', 'en']),
          lead: { nl: 'Geen speklaag, wel een dikke vacht.', en: 'No blubber, but a thick coat.' },
          authorIds: [r.person('lotte')],
          sectionId: r.section('achtergrond'),
          tags: ['winter'],
          presentation: { header: 'cover' },
          blocks: [
            text({
              nl: [p('Een otter heeft geen vetlaag. Hij houdt het warm met een dikke vacht.')],
              en: [p('An otter has no fat layer. It keeps warm with a thick coat.')],
            }),
          ],
        },
      ],
      behind: ['en'],
    }
  ),
  article({
    key: 'jaarcijfers',
    slug: 'otterdam-in-cijfers-2025',
    title: { nl: 'Otterdam in cijfers: 2025' },
    date: '2026-01-14',
    section: 'nieuws',
    authors: ['ravi', 'anouk'],
    tags: ['jaarverslag'],
    blocks: (r) => [
      text({
        nl: [
          p('Een jaar in vier getallen:'),
          ul(
            '214 vrijwilligers deden mee aan de tellingen.',
            '6 nieuwe faunapassages, samen met de waterbeheerders.',
            '38 dode otters gevonden sinds 2020, 27 door verkeer.',
            '61 procent van onze inkomsten kwam van particulieren.'
          ),
          p('Het hele verhaal staat in ', to('het jaarverslag', r.item('jaarverslag')), '.'),
        ],
      }),
    ],
  }),
  article({
    key: 'scholen',
    slug: 'basisscholen-zoeken-sporen',
    title: { nl: 'Basisscholen zoeken sporen langs de singels' },
    date: '2026-02-10',
    section: 'op-pad',
    authors: ['pieter'],
    tags: ['scholen', 'singels'],
    photo: 'sporen',
    lead: { nl: 'Met Natuurlab Zuid gingen twaalf klassen op pad.' },
    blocks: (r) => [
      text({
        nl: [
          p(
            'Elke klas kreeg een stuk singel, een meetlint en een zoekkaart. Drie klassen vonden een spoor.'
          ),
        ],
      }),
      block('people-grid', {
        source: 'selection',
        groupId: null,
        people: [{ personId: r.person('leerlingen') }, { personId: r.person('pieter') }],
        columns: '2',
        showRole: true,
        showBio: false,
        showContact: false,
      }),
      text({ nl: [p('Volgend jaar willen we met twintig klassen.')] }),
    ],
  }),
  article({
    key: 'podcast-1',
    slug: 'nieuwe-podcast-onder-water',
    title: { nl: 'Nieuw: de podcast Onder water' },
    date: '2026-03-05',
    section: 'nieuws',
    authors: ['lotte'],
    tags: ['podcast'],
    photo: 'zandbank',
    lead: { nl: 'Elke maand een gesprek met iemand die de otter van dichtbij kent.' },
    blocks: (r) => [
      text({
        nl: [
          p(
            'In de eerste aflevering vertelt Joris hoe we tellen. Luister hier of op ',
            to('de podcastpagina', r.item('podcast')),
            '.'
          ),
        ],
      }),
      block('audio', {
        title: { nl: 'Aflevering 1: tellen in de Biesbosch' },
        fileId: r.media('podcast'),
      }),
      text({ nl: [p('Tips voor gasten zijn welkom.')] }),
    ],
  }),
  article({
    key: 'petitie-gestart',
    slug: 'petitie-veilige-vistrappen-gestart',
    title: { nl: 'Petitie gestart: veilige vistrappen voor de otter' },
    date: '2026-04-01',
    section: 'campagnes',
    authors: ['samira'],
    tags: ['petitie', 'vistrap'],
    photo: 'zandbank',
    dossiers: ['dossier-verkeer'],
    lead: { nl: 'We willen 2.500 handtekeningen voor de zomer.' },
    blocks: (r) => [
      text({
        nl: [
          p(
            'Een vistrap kost al snel een paar ton. Een looprichel erbij kost een fractie. Toch gebeurt het niet vanzelf.'
          ),
        ],
      }),
      block('campaign-card', {
        campaignId: r.campaign('vistrappen'),
        variant: 'compact',
        width: 'content',
      }),
      text({ nl: [p('Teken en deel hem met je buren.')] }),
    ],
  }),
  article({
    key: 'video',
    slug: 'video-otters-in-de-sneeuw',
    title: { nl: 'Video: otters in de sneeuw' },
    date: '2026-04-22',
    section: 'achtergrond',
    authors: ['lotte'],
    tags: ['video'],
    lead: { nl: 'Twee minuten otters, zonder commentaar.' },
    blocks: () => [
      say({
        nl: 'Deze beelden zijn gemaakt in een nationaal park in Noord-Amerika, waar otters minder schuw zijn.',
      }),
      block('video-embed', {
        provider: 'youtube',
        videoId: 'aqz-KE-bpKQ',
        title: { nl: 'Otters in de sneeuw' },
        caption: { nl: 'Video van een externe bron; afspelen laadt de speler pas na toestemming.' },
        width: 'wide',
      }),
      say({ nl: 'Hier in de Maasdelta zie je ze bijna nooit zo dichtbij.' }),
    ],
  }),
  article({
    key: 'water-metingen',
    slug: 'waterkwaliteit-in-de-singels-gemeten',
    title: { nl: 'Waterkwaliteit in de singels: wat we maten' },
    date: '2026-05-18',
    section: 'onderzoek',
    authors: ['joris'],
    tags: ['waterkwaliteit', 'singels'],
    photo: 'panorama',
    dossiers: ['dossier-water'],
    lead: { nl: 'Zuurstof, troebelheid en vis: drie metingen op twaalf plekken.' },
    blocks: () => [
      text({
        nl: [
          p(
            'Op acht van de twaalf plekken was genoeg zuurstof voor vis. Op vier plekken niet, vooral in de zomer.'
          ),
          h(2, 'Wat helpt'),
          ul(
            'Minder overstorten bij hevige regen.',
            'Meer stroming door gemalen slimmer te laten draaien.',
            'Begroeide oevers in plaats van beschoeiing.'
          ),
        ],
      }),
    ],
  }),
  article({
    key: 'leden-verslag',
    slug: 'van-de-directeur-een-moeilijk-jaar',
    title: { nl: 'Van de directeur: een moeilijk jaar' },
    date: '2026-06-24',
    section: 'nieuws',
    authors: ['anouk'],
    tags: ['leden'],
    photo: 'portret',
    lead: { nl: 'Een persoonlijke terugblik, alleen voor onze leden.' },
    extra: () => ({ access: { level: 'members', teaser: 'marker' } }),
    blocks: () => [
      text({
        nl: [
          p(
            'Dit jaar vonden we meer dode otters dan ooit. Dat klinkt slecht, en dat is het ook. Maar het betekent ook dat er meer otters zijn.'
          ),
        ],
      }),
      block('paywall', {}),
      text({
        nl: [
          p(
            'Wat me het meest raakte, was een moederdier dat we vonden op de Kreekweg, een week voordat de nieuwe vistrap openging. Twee weken later zagen we haar jongen op de camera.'
          ),
          p('Ik wil jullie bedanken. Zonder leden hadden we die camera niet gehad.'),
        ],
      }),
    ],
  }),
  article(
    {
      key: 'vrijwilliger',
      slug: 'een-dag-met-een-vrijwilliger',
      title: { nl: 'Een dag met een vrijwilliger' },
      date: '2026-07-15',
      section: 'op-pad',
      authors: ['lotte'],
      tags: ['vrijwilligers'],
      photo: 'oever',
      lead: { nl: 'Om zes uur ’s ochtends op de dijk, met een thermoskan en een zoekkaart.' },
      blocks: (r) => [
        text({
          nl: [
            p(
              'Marieke is 71 en telt al zes jaar mee. ',
              italic(
                '“Je ziet de otter bijna nooit. Maar je weet dat hij er was. Dat vind ik het mooiste.”'
              )
            ),
          ],
        }),
        image(r, 'sporen', { layout: 'float-left' }),
        text({
          nl: [
            p(
              'Ze loopt elke maand dezelfde route van vier kilometer, en noteert alles: sporen, spraints, maar ook vuil en kapotte hekken.'
            ),
            p('Ook meedoen? Kijk bij ', to('de evenementen', r.item('evenementen')), '.'),
          ],
        }),
      ],
    },
    {
      // Saved three times: an editor's earlier versions stay in the history.
      earlier: () => [
        {
          type: 'article',
          title: { nl: 'Een dag met een vrijwilliger' },
          defaultLocale: 'nl',
          locales: ['nl'],
          blocks: [say({ nl: 'Concept: interview met Marieke.' })],
        },
        {
          type: 'article',
          title: { nl: 'Een dag met een vrijwilliger' },
          defaultLocale: 'nl',
          locales: ['nl'],
          lead: { nl: 'Om zes uur op de dijk.' },
          blocks: [say({ nl: 'Marieke is 71 en telt al zes jaar mee.' })],
        },
      ],
    }
  ),
  article({
    key: 'zeeotters',
    slug: 'zeeotter-en-rivierotter-het-verschil',
    title: { nl: 'Zeeotter en rivierotter: het verschil' },
    date: '2026-08-26',
    section: 'achtergrond',
    authors: ['joris'],
    tags: ['soorten'],
    photo: 'drijven',
    lead: { nl: 'Familie, maar met een heel ander leven.' },
    blocks: () => [
      text({
        nl: [
          p(
            'De zeeotter leeft in de Stille Oceaan en komt bijna nooit aan land. Onze rivierotter, ',
            italic('Lutra lutra'),
            ', leeft langs zoet water en slaapt in een hol in de oever.'
          ),
          p(
            'Op foto’s van zeeotters die drijvend slapen, houden ze elkaars poot vast. Rivierotters doen dat niet.'
          ),
        ],
      }),
    ],
  }),
  article({
    key: 'faunapassages',
    slug: 'zes-nieuwe-faunapassages',
    title: { nl: 'Zes nieuwe faunapassages in één jaar' },
    date: '2026-10-08',
    section: 'campagnes',
    authors: ['samira', 'joris'],
    tags: ['faunapassage', 'verkeer'],
    photo: 'glijbaan',
    cover: true,
    dossiers: ['dossier-verkeer'],
    lead: { nl: 'Wat begon met één richel, is nu beleid.' },
    blocks: (r) => [
      text({
        nl: [
          p(
            'De waterbeheerders hebben toegezegd bij elke nieuwe vistrap een looprichel aan te leggen. Dat is precies wat onze petitie vroeg.'
          ),
        ],
      }),
      block('callout', {
        variant: 'note',
        title: { nl: 'Bedankt' },
        body: rich({ nl: [p('Aan alle ', bold('2.614'), ' mensen die tekenden.')] }),
      }),
      text({
        nl: [
          p(
            'We blijven meten of de passages ook gebruikt worden. Lees ',
            to('alles over otters en verkeer', r.item('dossier-verkeer')),
            '.'
          ),
        ],
      }),
    ],
  }),
  article({
    key: 'najaarstelling',
    slug: 'najaarstelling-2026',
    title: { nl: 'Najaarstelling 2026: meer sporen dan ooit' },
    date: '2026-11-12',
    section: 'onderzoek',
    authors: ['joris'],
    tags: ['telling', 'onderzoek'],
    photo: 'familie',
    lead: { nl: '87 vindplaatsen, en voor het eerst sporen ten westen van de stad.' },
    blocks: () => [
      text({
        nl: [
          p(
            'De vrijwilligers liepen 42 routes. Op 87 plekken vonden ze sporen of spraints, tegen 61 vorig jaar.'
          ),
          p('Opvallend: drie vondsten langs de Nieuwe Waterweg, waar we nog nooit iets zagen.'),
        ],
      }),
      block('timeline', {
        title: { nl: 'Vindplaatsen per jaar' },
        order: 'newest',
        events: [
          { date: '2024-11-01', title: { nl: '44 vindplaatsen' } },
          { date: '2025-11-01', title: { nl: '61 vindplaatsen' } },
          { date: '2026-11-01', title: { nl: '87 vindplaatsen' } },
        ],
      }),
      text({ nl: [p('De volgende telling is in april.')] }),
    ],
  }),
  article(
    {
      key: 'kerst',
      slug: 'kerstwandeling-aangekondigd',
      title: { nl: 'Kerstwandeling langs de kreken' },
      date: '2026-12-15',
      section: 'op-pad',
      authors: ['pieter'],
      tags: ['excursie'],
      lead: { nl: 'Op tweede kerstdag lopen we met warme chocolademelk langs de kreken.' },
      blocks: () => [say({ nl: 'Dit bericht verschijnt op 15 december; het staat ingepland.' })],
    },
    { status: 'scheduled', at: '2026-12-15T09:00:00+01:00' }
  ),
  article(
    {
      key: 'concept',
      slug: 'interview-met-een-visser',
      title: { nl: 'Interview met een visser (concept)' },
      date: '2026-11-20',
      section: 'achtergrond',
      authors: ['lotte'],
      lead: { nl: 'Hoe een stopnet in een fuik een otter redt.' },
      blocks: () => [
        text({ nl: [p('Nog uitwerken: vragen over fuiken en stopnetten.'), p('Foto’s volgen.')] }),
      ],
    },
    { status: 'draft' }
  ),
];
