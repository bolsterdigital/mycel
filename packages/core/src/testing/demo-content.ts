// Demo content for the probe tenant: one filled page and one filled article in nl and
// en, so the admin and the public site can be judged on something that looks like a real site
// instead of a heading and a form. Together the two documents use every block type of
// `BLOCK_DEFINITIONS` at its current version, interleave rich text with the other blocks, and
// carry a lead and a hero image. The organisation, its people and its numbers are fictional.
// Demo copy never names, links to or promises a feature the platform does not have yet: a probe
// reader takes what the demo shows as what the platform does.
//
// The core cannot draw pixels (no I/O library, ADR 001), so `seedDemoContent` takes a `render`
// function for the images and uploads them through `media.upload` like any front; the dev seed
// passes the sharp renderer of `@mycel/media-sharp`, a test passes a PNG header. Rejected: the
// examples of each block definition as demo content (they show each variant in isolation, with
// ids that resolve to nothing) and committed image files (binary weight for a picture of a label).

import type { z } from 'zod';
import type { ContentItem } from '../content/model.js';
import type { RichTextDoc } from '../content/rich-text.js';
import type { Invoker } from '../invoke.js';
import type { Principal } from '../principal.js';
import { BLOCK_DEFINITIONS } from '../content/block-types.js';
import { useCases } from '../use-cases.js';
import { bytesToBase64 } from '../util/bytes.js';
import { publishProbePage } from './fixtures.js';

type L = { nl: string; en: string };
type CreateInput = z.input<typeof useCases.createItem.input>;
type BlockIn = CreateInput['document']['blocks'][number];

// --- images -----------------------------------------------------------------------------------

export type DemoImageKey = 'market' | 'bakery' | 'measuring' | 'signatures';

/** What `render` draws (a gradient and a label) and what the upload stores with it. */
export interface DemoImage {
  key: DemoImageKey;
  filename: string;
  width: number;
  height: number;
  label: string;
  /** Gradient from the top left to the bottom right, as `#rrggbb`. */
  colors: readonly [string, string];
  alt: L;
  caption: L;
}

export const DEMO_IMAGES: readonly DemoImage[] = [
  {
    key: 'market',
    filename: 'demo-proeverij-op-de-markt.png',
    width: 1600,
    height: 900,
    label: 'Proeverij op de markt',
    colors: ['#1f6f5c', '#0b2e4a'],
    alt: {
      nl: 'Een kraam op de zaterdagmarkt met schalen pepernoten en bordjes met zoutgehaltes',
      en: 'A stall at the Saturday market with bowls of pepernoten and signs showing salt levels',
    },
    caption: {
      nl: 'De eerste blinde proeverij, op de zaterdagmarkt in de Lindewijk.',
      en: 'The first blind tasting, at the Saturday market in the Lindewijk.',
    },
  },
  {
    key: 'bakery',
    filename: 'demo-in-de-bakkerij.png',
    width: 1600,
    height: 900,
    label: 'In de bakkerij',
    colors: ['#b4532a', '#5a1e3c'],
    alt: {
      nl: 'Een bakker weegt zout af boven een grote kom deeg',
      en: 'A baker weighs out salt above a large bowl of dough',
    },
    caption: {
      nl: 'Veertien bakkers testten het recept met de helft van het zout.',
      en: 'Fourteen bakers tested the recipe with half the salt.',
    },
  },
  {
    key: 'measuring',
    filename: 'demo-zoutmeting.png',
    width: 900,
    height: 1200,
    label: 'Zoutmeting',
    colors: ['#3b3f8f', '#141a33'],
    alt: {
      nl: 'Een vrijwilliger leest een zoutmeter af naast een zakje pepernoten',
      en: 'A volunteer reads a salt meter next to a bag of pepernoten',
    },
    caption: {
      nl: 'Elke zak werd drie keer gemeten, door twee verschillende vrijwilligers.',
      en: 'Every bag was measured three times, by two different volunteers.',
    },
  },
  {
    key: 'signatures',
    filename: 'demo-aanbieding.png',
    width: 1600,
    height: 900,
    label: 'Aanbieding rapport',
    colors: ['#8a6d1d', '#2f3a12'],
    alt: {
      nl: 'Twee vrijwilligers overhandigen het zoutrapport aan een raadslid in het stadhuis',
      en: 'Two volunteers hand the salt report to a councillor in the town hall',
    },
    caption: {
      nl: 'Het rapport werd in oktober aangeboden aan de gemeenteraad.',
      en: 'The report was handed to the council in October.',
    },
  },
];

export type DemoMediaIds = Record<DemoImageKey, string>;

// --- rich-text builders -----------------------------------------------------------------------

// Plain JSON in the shapes of `rich-text.ts`; `doc` checks nothing, the tests parse every document.
type Inline = { type: 'text'; text: string; marks?: object[] };
type Part = string | Inline;

const inline = (part: Part): Inline =>
  typeof part === 'string' ? { type: 'text', text: part } : part;
const p = (...parts: Part[]) => ({ type: 'paragraph', content: parts.map(inline) });
const h = (level: 1 | 2 | 3, text: string) => ({
  type: 'heading',
  attrs: { level },
  content: [inline(text)],
});
const item = (text: string) => ({ type: 'list_item', content: [p(text)] });
const ul = (...items: string[]) => ({ type: 'bullet_list', content: items.map(item) });
const ol = (...items: string[]) => ({ type: 'ordered_list', content: items.map(item) });
const a = (text: string, href: string): Inline => ({
  type: 'text',
  text,
  marks: [{ type: 'link', attrs: { href } }],
});
const to = (text: string, itemId: string): Inline => ({
  type: 'text',
  text,
  marks: [{ type: 'link', attrs: { itemId } }],
});
const b = (text: string): Inline => ({ type: 'text', text, marks: [{ type: 'bold' }] });
const doc = (...content: object[]) => ({ type: 'doc', content }) as RichTextDoc;

const richText = (nl: RichTextDoc, en: RichTextDoc): BlockIn => ({
  type: 'rich-text',
  version: BLOCK_DEFINITIONS['rich-text'].version,
  props: { content: { nl, en } },
});
const heading = (text: L): BlockIn => ({
  type: 'heading',
  version: BLOCK_DEFINITIONS.heading.version,
  props: { text },
});

const ARTICLE_SLUG = 'pepernoten-te-zout';
const PAGE_SLUG = 'over-ons';
const VIDEO_ID = 'aqz-KE-bpKQ';

// --- the page ---------------------------------------------------------------------------------

const PAGE_TITLE: L = {
  nl: 'Over Stichting Gezonde Trommel',
  en: 'About the Healthy Tin Foundation',
};
const PAGE_LEAD: L = {
  nl: 'Wij zijn een vrijwilligersorganisatie die zich inzet voor snoepgoed en tussendoortjes met minder zout en suiker, zonder dat de feestdagen minder feestelijk worden.',
  en: 'We are a volunteer organisation working for sweets and snacks with less salt and sugar, without making the holidays any less festive.',
};

function pageIntro(): BlockIn {
  return richText(
    doc(
      h(1, 'Wie we zijn'),
      p(
        'Stichting Gezonde Trommel begon in 2021 aan een keukentafel in de Lindewijk. Drie ouders vroegen zich af waarom de pepernoten op school zo zout smaakten, en lieten een paar zakken onderzoeken. De uitkomst verbaasde ze zo dat ze besloten er werk van te maken. Inmiddels zijn we met ruim tweehonderd vrijwilligers in negen gemeenten.'
      ),
      p(
        'We zijn onafhankelijk en nemen geen geld aan van fabrikanten of supermarkten. Ons werk wordt betaald door kleine donaties van mensen die het belangrijk vinden dat kinderen gezond kunnen snoepen. Hoe we dat geld besteden, lees je in ',
        a('ons jaarverslag', 'https://example.org/gezonde-trommel/jaarverslag'),
        '.'
      )
    ),
    doc(
      h(1, 'Who we are'),
      p(
        'The Healthy Tin Foundation started in 2021 around a kitchen table in the Lindewijk. Three parents wondered why the pepernoten at school tasted so salty, and had a few bags tested. The result surprised them so much that they decided to do something about it. Today we are more than two hundred volunteers in nine municipalities.'
      ),
      p(
        'We are independent and take no money from manufacturers or supermarkets. Our work is paid for by small donations from people who think children should be able to enjoy sweets that are good for them. How we spend that money is in ',
        a('our annual report', 'https://example.org/gezonde-trommel/jaarverslag'),
        '.'
      )
    )
  );
}

function pageWork(): BlockIn {
  return richText(
    doc(
      p(
        'We werken op drie manieren. Geen van de drie is spectaculair, maar samen zorgen ze ervoor dat er echt iets verandert in de schappen en op de schoolpleinen.'
      ),
      ul(
        'We meten: vrijwilligers kopen elk najaar het snoepgoed dat in de winkel ligt en laten het onafhankelijk onderzoeken.',
        'We bakken mee: samen met lokale bakkers ontwikkelen we recepten die net zo lekker zijn, met de helft van het zout.',
        'We praten mee: met scholen, gemeenten en fabrikanten, op basis van wat we gemeten hebben.'
      ),
      p(
        'Alles wat we meten publiceren we, ook als de uitkomst ons niet uitkomt. Zo kan iedereen onze cijfers controleren, en dat is precies de bedoeling.'
      )
    ),
    doc(
      p(
        'We work in three ways. None of them is spectacular, but together they make sure that something really changes on the shelves and in the playgrounds.'
      ),
      ul(
        'We measure: every autumn, volunteers buy the sweets that are on sale and have them tested independently.',
        'We bake along: together with local bakers we develop recipes that taste just as good, with half the salt.',
        'We take part in the conversation: with schools, councils and manufacturers, based on what we measured.'
      ),
      p(
        'We publish everything we measure, even when the outcome does not suit us. That way anyone can check our figures, which is exactly the point.'
      )
    )
  );
}

function pageMethod(): BlockIn {
  return richText(
    doc(
      h(1, 'Hoe een meting verloopt'),
      ol(
        'Vrijwilligers kopen in twee weken tijd zoveel mogelijk verschillende zakken in gewone winkels.',
        'Een onafhankelijk laboratorium meet het zout- en suikergehalte, zonder te weten van welk merk een zak is.',
        'Twee vrijwilligers controleren de uitslagen los van elkaar.',
        'We sturen fabrikanten de uitslag voordat we publiceren, zodat ze kunnen reageren.'
      ),
      p(
        'Een meting kost ons ongeveer vierduizend euro. Dat lijkt veel, maar het is het verschil tussen een vermoeden en een feit. En met feiten kun je in een gemeenteraad of een directiekamer veel meer bereiken.'
      )
    ),
    doc(
      h(1, 'How a measurement works'),
      ol(
        'Over two weeks, volunteers buy as many different bags as they can in ordinary shops.',
        'An independent laboratory measures salt and sugar levels without knowing which brand a bag is.',
        'Two volunteers check the results independently of each other.',
        'We send manufacturers the results before we publish, so they can respond.'
      ),
      p(
        'One measurement costs us about four thousand euros. That sounds like a lot, but it is the difference between a hunch and a fact. And with facts you get much further in a council meeting or a boardroom.'
      )
    )
  );
}

function pageClosing(): BlockIn {
  return richText(
    doc(
      p(
        'We zijn een kleine organisatie met een duidelijk doel. Wil je weten wat we dit jaar gemeten hebben? Lees dan ',
        a('ons onderzoek naar pepernoten', `/articles/${ARTICLE_SLUG}`),
        '. Heb je een vraag die hierboven niet beantwoord wordt, mail ons dan op ',
        a('hallo@example.org', 'mailto:hallo@example.org'),
        '. We antwoorden binnen een week, meestal sneller.'
      )
    ),
    doc(
      p(
        'We are a small organisation with a clear goal. Want to know what we measured this year? Read ',
        a('our study of pepernoten', `/en/articles/${ARTICLE_SLUG}`),
        '. If you have a question that is not answered above, e-mail us at ',
        a('hallo@example.org', 'mailto:hallo@example.org'),
        '. We reply within a week, usually sooner.'
      )
    )
  );
}

const PAGE_FAQ = [
  {
    question: { nl: 'Zijn jullie tegen snoep?', en: 'Are you against sweets?' },
    answer: {
      nl: doc(
        p(
          'Nee. We houden van pepernoten, kruidnoten en chocoladeletters. We willen alleen dat ze niet onnodig zout of zoet zijn.'
        )
      ),
      en: doc(
        p(
          'No. We love pepernoten, kruidnoten and chocolate letters. We just want them not to be needlessly salty or sweet.'
        )
      ),
    },
  },
  {
    question: { nl: 'Wie betaalt jullie?', en: 'Who pays you?' },
    answer: {
      nl: doc(
        p(
          'Ruim negenhonderd donateurs met een gemiddelde gift van zeven euro per maand. We nemen geen geld aan van bedrijven die snoep maken of verkopen.'
        )
      ),
      en: doc(
        p(
          'More than nine hundred donors giving seven euros a month on average. We take no money from companies that make or sell sweets.'
        )
      ),
    },
  },
  {
    question: { nl: 'Kan ik vrijwilliger worden?', en: 'Can I volunteer?' },
    answer: {
      nl: doc(
        p(
          'Graag. De meeste vrijwilligers helpen twee weken per jaar met kopen en meten. Laat je e-mailadres achter onderaan deze pagina, dan nemen we contact op.'
        )
      ),
      en: doc(
        p(
          'Please do. Most volunteers help for two weeks a year with buying and measuring. Leave your e-mail address at the bottom of this page and we will be in touch.'
        )
      ),
    },
  },
  {
    question: {
      nl: 'Werken jullie ook buiten Nederland?',
      en: 'Do you work outside the Netherlands?',
    },
    answer: {
      nl: doc(
        p(
          'Nog niet. Een Vlaamse groep ouders gebruikt wel onze meetmethode, en we delen onze recepten met iedereen die erom vraagt.'
        )
      ),
      en: doc(
        p(
          'Not yet. A group of Flemish parents does use our measuring method, and we share our recipes with anyone who asks.'
        )
      ),
    },
  },
  {
    question: { nl: 'Hoe kan ik jullie cijfers controleren?', en: 'How can I check your figures?' },
    answer: {
      nl: doc(
        p(
          'Alle labuitslagen staan in ',
          a('onze open dataset', 'https://example.org/gezonde-trommel/data'),
          ', per zak en per meting.'
        )
      ),
      en: doc(
        p(
          'Every laboratory result is in ',
          a('our open dataset', 'https://example.org/gezonde-trommel/data'),
          ', per bag and per measurement.'
        )
      ),
    },
  },
];

function pageCards(formId: string, media: DemoMediaIds): BlockIn[] {
  const market = DEMO_IMAGES[0]!;
  const signatures = DEMO_IMAGES[3]!;
  return [
    {
      type: 'hero',
      version: BLOCK_DEFINITIONS.hero.version,
      props: {
        variant: 'cover',
        title: { nl: 'Minder zout, meer smaak', en: 'Less salt, more flavour' },
        body: {
          nl: 'Samen met ouders, bakkers en scholen maken we snoepgoed gezonder, één meting tegelijk.',
          en: 'Together with parents, bakers and schools we make sweets healthier, one measurement at a time.',
        },
        image: {
          mediaId: media.market,
          decorative: false,
          alt: market.alt,
          caption: market.caption,
        },
        actions: [
          {
            label: { nl: 'Lees ons onderzoek', en: 'Read our study' },
            target: { kind: 'url', url: `/articles/${ARTICLE_SLUG}` },
          },
          {
            label: { nl: 'Blijf op de hoogte', en: 'Stay informed' },
            target: { kind: 'url', url: '/signup' },
          },
        ],
        align: 'start',
      },
    },
    {
      type: 'image',
      version: BLOCK_DEFINITIONS.image.version,
      props: {
        mediaId: media.signatures,
        decorative: false,
        alt: signatures.alt,
        // This use's own caption, over the asset's.
        caption: {
          nl: 'Vrijwilligers sorteren de steunbetuigingen na de actiedag van vorig jaar.',
          en: "Volunteers sort the messages of support after last year's day of action.",
        },
        credit: { work: null, photographer: 'Demo-afbeelding, gemaakt door de Mycel-seed' },
        layout: 'wide',
      },
    },
    {
      type: 'quote',
      version: BLOCK_DEFINITIONS.quote.version,
      props: {
        text: {
          nl: 'Niemand wil kinderen hun pepernoten afpakken. We willen alleen weten wat erin zit, en dat het beter kan.',
          en: 'Nobody wants to take pepernoten away from children. We just want to know what is in them, and that they can be better.',
        },
        attribution: {
          name: 'Noor Hendriks',
          role: { nl: 'voorzitter van de stichting', en: 'chair of the foundation' },
        },
        variant: 'pullquote',
        width: 'wide',
      },
    },
    {
      type: 'faq',
      version: BLOCK_DEFINITIONS.faq.version,
      props: {
        variant: 'accordion',
        title: { nl: 'Veelgestelde vragen', en: 'Frequently asked questions' },
        entries: PAGE_FAQ,
      },
    },
    {
      type: 'callout',
      version: BLOCK_DEFINITIONS.callout.version,
      props: {
        variant: 'note',
        title: { nl: 'Onafhankelijk', en: 'Independent' },
        body: {
          nl: doc(
            p(
              'We nemen ',
              b('geen geld'),
              ' aan van fabrikanten, supermarkten of brancheorganisaties. Ook niet voor een "samenwerking" of een "pilot". Zo hoeft niemand te twijfelen aan onze cijfers.'
            )
          ),
          en: doc(
            p(
              'We take ',
              b('no money'),
              ' from manufacturers, supermarkets or trade associations. Not for a "partnership" or a "pilot" either. That way nobody has to doubt our figures.'
            )
          ),
        },
      },
    },
    {
      type: 'cta',
      version: BLOCK_DEFINITIONS.cta.version,
      props: {
        variant: 'card',
        title: { nl: 'Help mee meten', en: 'Help us measure' },
        body: {
          nl: 'Voor de meting van volgend jaar zoeken we nog veertig vrijwilligers. Twee weken in november, een paar uur per week, in je eigen buurt.',
          en: 'For next year we are still looking for forty volunteers. Two weeks in November, a few hours a week, in your own neighbourhood.',
        },
        actions: [
          {
            label: { nl: 'Meld je aan', en: 'Sign up' },
            target: { kind: 'url', url: '/signup' },
          },
          {
            label: { nl: 'Lees eerst het onderzoek', en: 'Read the study first' },
            target: { kind: 'url', url: `/articles/${ARTICLE_SLUG}` },
          },
        ],
        width: 'wide',
        align: 'center',
      },
    },
    {
      type: 'video-embed',
      version: BLOCK_DEFINITIONS['video-embed'].version,
      props: {
        provider: 'youtube',
        videoId: VIDEO_ID,
        title: {
          nl: 'Voorbeeldvideo: Big Buck Bunny van de Blender Foundation',
          en: 'Sample video: Big Buck Bunny by the Blender Foundation',
        },
        caption: {
          nl: 'Een open film als plaatsvervanger, tot de stichting een eigen video heeft.',
          en: 'An open film as a stand-in, until the foundation has a video of its own.',
        },
      },
    },
    {
      type: 'form',
      version: BLOCK_DEFINITIONS.form.version,
      props: { formId, variant: 'card', width: 'wide' },
    },
  ];
}

/** `content.item.create` input for the demo page: 13 blocks, hero first and the form last. */
export function demoPage(refs: { formId: string; media: DemoMediaIds }): CreateInput {
  const [hero, image, quote, faq, callout, cta, video, form] = pageCards(refs.formId, refs.media);
  return {
    slug: PAGE_SLUG,
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: PAGE_TITLE,
      lead: PAGE_LEAD,
      heroImageId: refs.media.bakery,
      featuredImageId: refs.media.market,
      blocks: [
        hero!,
        pageIntro(),
        image!,
        heading({ nl: 'Wat we doen', en: 'What we do' }),
        pageWork(),
        quote!,
        pageMethod(),
        faq!,
        callout!,
        pageClosing(),
        cta!,
        video!,
        form!,
      ],
    },
  };
}

// --- the article ------------------------------------------------------------------------------

const ARTICLE_TITLE: L = {
  nl: 'Pepernoten zijn vaak zouter dan chips',
  en: 'Pepernoten are often saltier than crisps',
};
const ARTICLE_LEAD: L = {
  nl: 'Wij lieten 48 zakken pepernoten en kruidnoten onderzoeken. In een derde ervan zat per honderd gram meer zout dan in een zak chips. Het kan anders: veertien bakkers bewezen dat de helft van het zout genoeg is.',
  en: 'We had 48 bags of pepernoten and kruidnoten tested. A third of them contained more salt per hundred grams than a bag of crisps. It can be done differently: fourteen bakers proved that half the salt is enough.',
};

function articleIntro(pageId: string): BlockIn {
  return richText(
    doc(
      p(
        'Wie aan pepernoten denkt, denkt aan kaneel, kruidnagel en suiker. Aan zout denkt bijna niemand. Toch blijkt uit onze meting van dit najaar dat een flink deel van de pepernoten in de winkel meer zout bevat dan een zak naturel chips. Bij de zoutste zak ging het om 1,4 gram per honderd gram, bijna een kwart van wat een kind van zes op een hele dag binnen zou mogen krijgen.'
      ),
      p(
        'De meting is uitgevoerd door vrijwilligers van ',
        to('Stichting Gezonde Trommel', pageId),
        ' in negen gemeenten. Een onafhankelijk laboratorium deed het onderzoek, zonder te weten van welk merk een zak was. Fabrikanten kregen de uitslagen een week voor publicatie toegestuurd.'
      )
    ),
    doc(
      p(
        'When people think of pepernoten they think of cinnamon, cloves and sugar. Almost nobody thinks of salt. Yet our measurement this autumn shows that a good share of the pepernoten in the shops contain more salt than a bag of plain crisps. The saltiest bag held 1.4 grams per hundred grams, almost a quarter of what a six-year-old should have in a whole day.'
      ),
      p(
        'The measurement was carried out by volunteers of ',
        to('the Healthy Tin Foundation', pageId),
        ' in nine municipalities. An independent laboratory did the testing without knowing which brand a bag was. Manufacturers received the results a week before publication.'
      )
    )
  );
}

function articleFindings(): BlockIn {
  return richText(
    doc(
      h(1, 'Wat we hebben gemeten'),
      p(
        'In totaal kochten we 48 verschillende zakken, van huismerken tot ambachtelijke bakkers. Het verschil tussen de zoutste en de minst zoute zak was groot: een factor vijf. Dat laat zien dat veel zout geen noodzaak is, maar een keuze.'
      ),
      ul(
        '16 van de 48 zakken bevatten meer dan 1 gram zout per 100 gram.',
        'De gemiddelde zak bevatte 0,8 gram zout per 100 gram.',
        'Ambachtelijke bakkers zaten gemiddeld lager dan fabrieksmatige merken, maar niet allemaal.',
        'Op geen enkele verpakking stond het zoutgehalte op de voorkant.'
      ),
      p(
        'Een zak van vijfhonderd gram is in veel gezinnen in een paar dagen leeg. Wie een handje per dag eet, krijgt er zo ongemerkt een flinke hoeveelheid zout bij.'
      )
    ),
    doc(
      h(1, 'What we measured'),
      p(
        'In total we bought 48 different bags, from supermarket own brands to artisan bakers. The difference between the saltiest and the least salty bag was large: a factor of five. That shows a lot of salt is not a necessity but a choice.'
      ),
      ul(
        '16 of the 48 bags contained more than 1 gram of salt per 100 grams.',
        'The average bag contained 0.8 grams of salt per 100 grams.',
        'Artisan bakers were lower on average than factory brands, but not all of them.',
        'Not a single package showed the salt content on the front.'
      ),
      p(
        'In many families a five-hundred-gram bag is empty within a few days. Eat a handful a day and you take in a fair amount of salt without noticing.'
      )
    )
  );
}

function articleWhy(): BlockIn {
  return richText(
    doc(
      p(
        'Te veel zout verhoogt op termijn de bloeddruk, ook bij kinderen. Het ',
        a('Voedingscentrum', 'https://www.voedingscentrum.nl/'),
        ' adviseert volwassenen maximaal zes gram zout per dag; voor kinderen ligt die grens lager. De meeste mensen zitten daar al ruim boven, vooral door brood, kaas en kant-en-klare producten.'
      ),
      p(
        'Snoep valt daarbij vaak buiten beeld, omdat het zoet smaakt. Juist daarom vinden we het belangrijk om het te meten. Zout in pepernoten is geen ramp, maar het is wel onnodig: in onze proeverij merkte het publiek geen verschil tussen het gewone recept en de versie met de helft van het zout.'
      )
    ),
    doc(
      p(
        'Too much salt raises blood pressure over time, in children too. The Dutch ',
        a('Nutrition Centre', 'https://www.voedingscentrum.nl/'),
        ' advises adults to have no more than six grams of salt a day; for children the limit is lower. Most people are already well above that, mainly through bread, cheese and ready-made products.'
      ),
      p(
        'Sweets often go unnoticed because they taste sweet. That is exactly why we think it matters to measure them. Salt in pepernoten is not a disaster, but it is unnecessary: at our tasting the public noticed no difference between the usual recipe and the version with half the salt.'
      )
    )
  );
}

function articleNext(): BlockIn {
  return richText(
    doc(
      h(1, 'Wat we nu vragen'),
      ol(
        'Fabrikanten: halveer het zout in pepernoten en kruidnoten vóór volgend najaar.',
        'Supermarkten: zet het zoutgehalte op de voorkant van de verpakking.',
        'Gemeenten: kies bij schoolfeesten en sinterklaasvieringen voor de zoutarme variant.'
      ),
      p(
        'Wil je weten wie zijn belofte nakomt? In januari meten we opnieuw; schrijf je in en je leest de uitkomst als eerste.'
      )
    ),
    doc(
      h(1, 'What we ask now'),
      ol(
        'Manufacturers: halve the salt in pepernoten and kruidnoten before next autumn.',
        'Supermarkets: put the salt content on the front of the package.',
        'Councils: choose the low-salt option for school parties and Sinterklaas celebrations.'
      ),
      p(
        'Want to know who keeps their promise? In January we measure again; sign up and you will read the outcome first.'
      )
    )
  );
}

const ARTICLE_FAQ = [
  {
    question: { nl: 'Welke merken waren het zoutst?', en: 'Which brands were the saltiest?' },
    answer: {
      nl: doc(
        p(
          'De volledige lijst, per zak en per meting, staat in ',
          a('onze open dataset', 'https://example.org/gezonde-trommel/data'),
          '.'
        )
      ),
      en: doc(
        p(
          'The full list, per bag and per measurement, is in ',
          a('our open dataset', 'https://example.org/gezonde-trommel/data'),
          '.'
        )
      ),
    },
  },
  {
    question: {
      nl: 'Is een handje pepernoten schadelijk?',
      en: 'Is a handful of pepernoten harmful?',
    },
    answer: {
      nl: doc(
        p(
          'Nee. Het gaat om wat je over een hele dag en een heel seizoen binnenkrijgt. Pepernoten zijn één van de vele bronnen, en een onnodige.'
        )
      ),
      en: doc(
        p(
          'No. What matters is what you take in over a whole day and a whole season. Pepernoten are one of many sources, and an unnecessary one.'
        )
      ),
    },
  },
  {
    question: { nl: 'Waarom zit er überhaupt zout in?', en: 'Why is there salt in them at all?' },
    answer: {
      nl: doc(
        p(
          'Een snufje zout versterkt de smaak van de kruiden. Bakkers die we spraken vinden de helft van de gebruikelijke hoeveelheid ruim voldoende.'
        )
      ),
      en: doc(
        p(
          'A pinch of salt brings out the flavour of the spices. The bakers we spoke to find half the usual amount more than enough.'
        )
      ),
    },
  },
  {
    question: {
      nl: 'Hebben de fabrikanten gereageerd?',
      en: 'Have the manufacturers responded?',
    },
    answer: {
      nl: doc(
        p(
          'Vijf van de twaalf fabrikanten reageerden. Twee zeggen hun recept volgend jaar aan te passen; we houden ze eraan.'
        )
      ),
      en: doc(
        p(
          'Five of the twelve manufacturers responded. Two say they will change their recipe next year; we will hold them to it.'
        )
      ),
    },
  },
];

function articleCards(formId: string, media: DemoMediaIds, pageId: string): BlockIn[] {
  const bakery = DEMO_IMAGES[1]!;
  const measuring = DEMO_IMAGES[2]!;
  return [
    {
      type: 'image',
      version: BLOCK_DEFINITIONS.image.version,
      props: {
        mediaId: media.measuring,
        decorative: false,
        alt: measuring.alt,
        caption: measuring.caption,
        layout: 'float-right',
      },
    },
    { type: 'paywall', version: BLOCK_DEFINITIONS.paywall.version, props: {} },
    {
      type: 'quote',
      version: BLOCK_DEFINITIONS.quote.version,
      props: {
        text: {
          nl: 'We hebben het recept gehalveerd en niemand in de winkel heeft het gemerkt. Eerlijk gezegd vond ik ze zelf lekkerder.',
          en: 'We halved the recipe and nobody in the shop noticed. To be honest, I liked them better myself.',
        },
        attribution: {
          name: 'Ahmed Yilmaz',
          role: { nl: 'bakker in de Lindewijk', en: 'baker in the Lindewijk' },
          source: { nl: 'tijdens de proeverij', en: 'at the tasting' },
        },
      },
    },
    {
      type: 'image',
      version: BLOCK_DEFINITIONS.image.version,
      props: {
        mediaId: media.bakery,
        decorative: false,
        alt: bakery.alt,
        caption: bakery.caption,
        layout: 'content',
      },
    },
    {
      type: 'callout',
      version: BLOCK_DEFINITIONS.callout.version,
      props: {
        variant: 'warning',
        title: { nl: 'Jonge kinderen', en: 'Young children' },
        body: {
          nl: doc(
            p(
              'Voor kinderen onder de vier is de grens voor zout nog lager. Geef ze liever een paar pepernoten dan een hele hand, en let op wat er de rest van de dag op tafel komt.'
            )
          ),
          en: doc(
            p(
              'For children under four the limit for salt is even lower. Give them a few pepernoten rather than a whole handful, and keep an eye on what else they eat that day.'
            )
          ),
        },
      },
    },
    {
      type: 'faq',
      version: BLOCK_DEFINITIONS.faq.version,
      props: {
        variant: 'accordion',
        title: { nl: 'Vragen over de meting', en: 'Questions about the measurement' },
        entries: ARTICLE_FAQ,
      },
    },
    {
      type: 'cta',
      version: BLOCK_DEFINITIONS.cta.version,
      props: {
        variant: 'band',
        title: { nl: 'Blijf op de hoogte', en: 'Stay informed' },
        body: {
          nl: 'Eén mail per maand over onze metingen en wat fabrikanten met onze vragen doen.',
          en: 'One e-mail a month about our measurements and what manufacturers do with our requests.',
        },
        actions: [
          {
            label: { nl: 'Schrijf je in', en: 'Sign up' },
            target: { kind: 'url', url: '/signup' },
          },
          {
            label: { nl: 'Over de stichting', en: 'About the foundation' },
            target: { kind: 'item', itemId: pageId },
          },
        ],
      },
    },
    {
      type: 'video-embed',
      version: BLOCK_DEFINITIONS['video-embed'].version,
      props: {
        provider: 'youtube',
        videoId: VIDEO_ID,
        title: {
          nl: 'Voorbeeldvideo: Big Buck Bunny van de Blender Foundation',
          en: 'Sample video: Big Buck Bunny by the Blender Foundation',
        },
        width: 'wide',
      },
    },
    {
      type: 'signup-form',
      version: BLOCK_DEFINITIONS['signup-form'].version,
      props: { formId },
    },
  ];
}

/**
 * `content.item.create` input for the demo article: 14 blocks. It links to the demo page by id,
 * so the page is created first. Public, with the `marker` teaser so the `paywall` block is valid:
 * a public item shows everything to everyone, so the boundary only shows in the admin.
 */
export function demoArticle(refs: {
  formId: string;
  media: DemoMediaIds;
  pageId: string;
}): CreateInput {
  const [image, paywall, quote, image2, callout, faq, cta, video, signup] = articleCards(
    refs.formId,
    refs.media,
    refs.pageId
  );
  return {
    slug: ARTICLE_SLUG,
    document: {
      type: 'article',
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: ARTICLE_TITLE,
      lead: ARTICLE_LEAD,
      heroImageId: refs.media.market,
      featuredImageId: refs.media.signatures,
      access: { level: 'public', teaser: 'marker' },
      tags: ['pepernoten', 'zout', 'onderzoek'],
      corrections: [
        {
          date: '2026-10-29',
          text: {
            nl: 'In een eerdere versie stond dat 18 zakken boven de 1 gram zaten; dat waren er 16.',
            en: 'An earlier version said 18 bags were above 1 gram; it was 16.',
          },
        },
      ],
      blocks: [
        articleIntro(refs.pageId),
        image!,
        articleFindings(),
        paywall!,
        quote!,
        heading({ nl: 'Waarom zout ertoe doet', en: 'Why salt matters' }),
        articleWhy(),
        image2!,
        callout!,
        faq!,
        articleNext(),
        cta!,
        video!,
        signup!,
      ],
    },
  };
}

// --- seeding ----------------------------------------------------------------------------------

export interface DemoSeed {
  page: ContentItem;
  article: ContentItem;
  /** False when both items already existed: nothing was uploaded or written. */
  created: boolean;
}

type Render = (image: DemoImage) => Promise<Uint8Array>;

/** The demo images by key: an asset with the same filename is reused, the rest uploaded. */
async function demoMedia(
  invoker: Invoker,
  principal: Principal,
  render: Render
): Promise<DemoMediaIds> {
  const media: Partial<DemoMediaIds> = {};
  for (const image of DEMO_IMAGES) {
    const { items } = await invoker.run(useCases.listMedia, principal, {
      kind: 'image',
      q: image.filename,
    });
    const found = items.find((m) => m.filename === image.filename);
    media[image.key] =
      found?.id ??
      (
        await invoker.run(useCases.uploadMedia, principal, {
          filename: image.filename,
          contentType: 'image/png',
          bytes: bytesToBase64(await render(image)),
          caption: image.caption,
        })
      ).id;
  }
  return media as DemoMediaIds;
}

/**
 * Upload the demo images, then create and publish the page and the article in every locale.
 * Idempotent: an item with the slug is kept as it is, and when both exist nothing is written.
 * `render` returns PNG bytes of `image.width` by `image.height`.
 */
export async function seedDemoContent(
  invoker: Invoker,
  principal: Principal,
  options: { formId: string; render: Render }
): Promise<DemoSeed> {
  const find = async (type: 'page' | 'article', slug: string) =>
    (await invoker.run(useCases.listItems, principal, { type, slug })).items[0];
  const existingPage = await find('page', PAGE_SLUG);
  const existingArticle = await find('article', ARTICLE_SLUG);
  if (existingPage && existingArticle)
    return { page: existingPage, article: existingArticle, created: false };

  const refs = {
    formId: options.formId,
    media: await demoMedia(invoker, principal, options.render),
  };
  const page =
    existingPage ?? (await publishProbePage(invoker, principal, refs.formId, demoPage(refs)));
  const article =
    existingArticle ??
    (await publishProbePage(
      invoker,
      principal,
      refs.formId,
      demoArticle({ ...refs, pageId: page.id })
    ));
  return { page, article, created: true };
}
