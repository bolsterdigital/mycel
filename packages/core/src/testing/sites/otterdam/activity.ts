// Otterdam's supporters and what they can join (MY-264 PR 2): two access tiers (a free reading
// club and a paid friends' membership), a donation page that is a fundraiser, a membership page,
// the closed reading-club page, an excursion people sign up for, a newsletter sent as an edition,
// the contact form with conditional fields and several notifications (ADR 023), and a handful of
// fictional people on `@otterdam.example` who signed, subscribed, gave, joined and read. Every
// page that is new here is a new item, so a test server seeded by PR 1 gains it on the next run.

import type { FormField } from '../../../forms/fields.js';
import type { SupporterDef } from '../activity.js';
import { block, p, say, text, ul } from '../rich.js';
import type { CampaignDef, FormDef, ItemDef, TierDef } from '../runner.js';
import { headerImage } from './media.js';

const NL_EN = ['nl', 'en'];

export const OTTERDAM_TIERS: TierDef[] = [
  {
    key: 'leesclub',
    slug: 'leesclub',
    tier: {
      name: { nl: 'Leesclub', en: 'Reading club' },
      description: { nl: 'Lezers die we zelf uitnodigen.', en: 'Readers we invite ourselves.' },
      order: 1,
    },
  },
  {
    key: 'vrienden',
    slug: 'vrienden',
    tier: {
      name: { nl: 'Vrienden van de otter', en: 'Friends of the otter' },
      kind: 'paid',
      prices: { month: 500, year: 5000 },
      signupPath: '/word-vriend',
      order: 2,
    },
  },
];

const both = (nl: string, en: string) => ({ nl, en });
const when = (value: string) => ({ op: 'equals' as const, fieldId: 'onderwerp', value });

/** The contact form's own fields, in order after the e-mail address it starts with. */
const CONTACT_FIELDS: FormField[] = [
  { id: 'naam', name: 'naam', type: 'text', required: true, label: both('Naam', 'Name') },
  {
    id: 'onderwerp',
    name: 'onderwerp',
    type: 'choice',
    required: true,
    label: both('Waar gaat het over?', 'What is it about?'),
    options: [
      { value: 'vraag', label: both('Een vraag', 'A question') },
      { value: 'waarneming', label: both('Ik zag een otter', 'I saw an otter') },
      { value: 'vrijwilliger', label: both('Ik wil helpen', 'I want to help') },
      { value: 'pers', label: both('Pers', 'Press') },
    ],
  },
  {
    id: 'plek',
    name: 'plek',
    type: 'text',
    required: false,
    label: both('Waar zag je hem?', 'Where did you see it?'),
    help: both('Een straat, brug of stuk oever.', 'A street, bridge or stretch of bank.'),
    activeWhen: when('waarneming'),
    requiredWhen: when('waarneming'),
  },
  {
    id: 'datum',
    name: 'datum',
    type: 'date',
    required: false,
    label: both('Wanneer?', 'When?'),
    activeWhen: when('waarneming'),
  },
  {
    id: 'dagdelen',
    name: 'dagdelen',
    type: 'multiple-choice',
    required: false,
    label: both('Wanneer kun je?', 'When are you available?'),
    options: [
      { value: 'ochtend', label: both('Ochtend', 'Morning') },
      { value: 'middag', label: both('Middag', 'Afternoon') },
      { value: 'weekend', label: both('Weekend', 'Weekend') },
    ],
    activeWhen: when('vrijwilliger'),
  },
  {
    id: 'redactie',
    name: 'redactie',
    type: 'text',
    required: false,
    label: both('Voor welke redactie?', 'For which newsroom?'),
    activeWhen: when('pers'),
    requiredWhen: when('pers'),
  },
  {
    id: 'bericht',
    name: 'bericht',
    type: 'textarea',
    required: true,
    maxLength: 4000,
    label: both('Je bericht', 'Your message'),
  },
];

/** Adds what a form lacks, by name, after what it has: idempotent, so safe on every run. */
const adding =
  (extra: readonly FormField[]) =>
  (fields: FormField[]): FormField[] => [
    ...fields,
    ...extra.filter((f) => !fields.some((g) => g.name === f.name)),
  ];

/** Replaces the contact form of PR 1: the same key and name, now shaped and with mail. */
export const CONTACT_FORM: Pick<FormDef, 'fields' | 'mail'> = {
  fields: adding(CONTACT_FIELDS),
  mail: {
    enabled: true,
    actions: [
      {
        id: 'team',
        enabled: true,
        kind: 'notification',
        recipients: ['info@otterdam.example'],
        template: {
          override: { subject: both('Nieuw bericht via de site', 'New message from the site') },
        },
      },
      {
        id: 'waarneming',
        enabled: true,
        kind: 'notification',
        when: when('waarneming'),
        recipients: ['onderzoek@otterdam.example'],
        template: {
          override: {
            subject: both('Waarneming bij {{field:plek}}', 'Sighting at {{field:plek}}'),
          },
        },
      },
      {
        id: 'pers',
        enabled: true,
        kind: 'notification',
        when: when('pers'),
        recipients: ['pers@otterdam.example'],
        template: {},
      },
      { id: 'ontvangst', enabled: true, kind: 'receipt', recipients: [], template: {} },
    ],
  },
};

export const OTTERDAM_ACTIVITY_FORMS: FormDef[] = [
  {
    key: 'doneer',
    kind: 'donation',
    name: both('Doneer aan Otterdam', 'Give to Otterdam'),
    // Once, monthly or yearly (MY-254): the same form, the visitor chooses.
    fields: (fields) =>
      fields.map((f) =>
        f.type === 'amount' && !f.intervals ? { ...f, intervals: ['once', 'month', 'year'] } : f
      ),
  },
  {
    key: 'vrienden',
    kind: 'membership',
    name: both('Word vriend', 'Become a friend'),
    tier: 'vrienden',
  },
  {
    key: 'otterspotten',
    kind: 'signup',
    name: both('Aanmelden otterspotten', 'Sign up for otter spotting'),
  },
];

export const OTTERDAM_ACTIVITY_CAMPAIGNS: CampaignDef[] = [
  // A fundraiser counts the paid gifts made through its form, in euro cents.
  {
    key: 'winteractie',
    kind: 'fundraiser',
    landing: 'doneer',
    form: 'doneer',
    goal: { target: 1_000_000, milestones: [250_000, 500_000] },
  },
  {
    key: 'otterspotten',
    kind: 'signup',
    landing: 'otterspotten',
    form: 'otterspotten',
    goal: { target: 20, milestones: [] },
  },
];

const page = (title: Record<string, string>, locales = ['nl']) => ({
  type: 'page' as const,
  title,
  defaultLocale: 'nl',
  locales,
});

export const OTTERDAM_ACTIVITY_ITEMS: ItemDef[] = [
  {
    key: 'doneer',
    slug: 'doneer',
    document: (r) => ({
      ...page(both('Doneer', 'Give'), NL_EN),
      ...headerImage(r, 'familie', NL_EN),
      lead: both(
        'Deze winter bouwen we looprichels onder tien bruggen. Help je mee?',
        'This winter we are building ledges under ten bridges. Will you help?'
      ),
      blocks: [
        text({
          nl: [
            p(
              'Een looprichel kost ongeveer duizend euro. Je kunt eenmalig geven, of maandelijks of jaarlijks.'
            ),
          ],
          en: [
            p('A ledge costs about a thousand euros. You can give once, or every month or year.'),
          ],
        }),
        block('form', { formId: r.form('doneer'), variant: 'card', width: 'content' }),
        text({
          nl: [p('Otterdam is een ANBI (fictief): je gift is aftrekbaar.')],
          en: [p('Otterdam is a registered charity (fictional): your gift is tax-deductible.')],
        }),
      ],
    }),
  },
  {
    key: 'word-vriend',
    slug: 'word-vriend',
    document: (r) => ({
      ...page(both('Word vriend van de otter', 'Become a friend of the otter'), NL_EN),
      lead: both(
        'Voor vijf euro per maand ben je vriend: je leest de Leesclub en krijgt ons jaarverslag als eerste.',
        'For five euros a month you are a friend: you read the Reading club and get our annual report first.'
      ),
      blocks: [
        text({
          nl: [p('Vrienden houden ons werk het hele jaar draaiende.')],
          en: [p('Friends keep our work going all year round.')],
        }),
        block('form', { formId: r.form('vrienden') }),
        text({
          nl: [p('Opzeggen kan altijd, via de link in elke bevestiging.')],
          en: [p('You can stop at any time, through the link in every confirmation.')],
        }),
      ],
    }),
  },
  {
    key: 'leesclub',
    slug: 'leesclub',
    document: (r) => ({
      ...page({ nl: 'Leesclub: het veldwerk van deze maand' }),
      lead: { nl: 'Voor leden van de Leesclub en vrienden: wat we deze maand in het veld zagen.' },
      access: { level: 'tier' as const, tierIds: [r.tier('leesclub'), r.tier('vrienden')] },
      blocks: [
        text({
          nl: [
            p('Op drie camera’s langs de Oude Maas zagen we dezelfde moeder met twee jongen.'),
            ul(
              'Camera 1: elf keer, steeds na middernacht.',
              'Camera 2: twee keer.',
              'Camera 3: niets, de batterij was leeg.'
            ),
            p('Volgende maand verplaatsen we camera 3 naar de vistrap bij de stuw.'),
          ],
        }),
      ],
    }),
  },
  {
    key: 'otterspotten',
    slug: 'otterspotten-bij-zonsopkomst',
    document: (r) => ({
      ...page({ nl: 'Otterspotten bij zonsopkomst' }),
      profile: 'event' as const,
      event: {
        startsAt: '2027-03-14T06:30',
        endsAt: '2027-03-14T09:00',
        location: { nl: 'Steiger bij het Zuiderpark (fictief), Otterdam' },
      },
      ...headerImage(r, 'drijven'),
      lead: {
        nl: 'Vroeg op, stil zijn en kijken: met Samira langs het water bij het eerste licht.',
      },
      blocks: [
        say({
          nl: 'Er zijn twintig plekken. Meld je aan, dan krijg je een week vooraf de details.',
        }),
        block('form', { formId: r.form('otterspotten') }),
        say({ nl: 'Neem warme kleding mee; koffie is er na afloop.' }),
      ],
    }),
  },
  {
    key: 'nieuwsbrief-november',
    slug: 'nieuwsbrief-november-2026',
    publishedAt: '2026-11-14T09:00:00+01:00',
    document: (r) => ({
      type: 'article' as const,
      title: both(
        'Nieuwsbrief november: tien bruggen voor de winter',
        'Newsletter November: ten bridges before winter'
      ),
      defaultLocale: 'nl',
      locales: NL_EN,
      lead: both(
        'Onze winteractie is begonnen, de petitie gaat naar de waterbeheerders en in maart gaan we otterspotten.',
        'Our winter appeal has started, the petition goes to the water managers and in March we go otter spotting.'
      ),
      authorIds: [r.person('anouk')],
      sectionId: r.section('nieuws'),
      tags: [],
      delivery: {
        web: true,
        email: {
          listId: 'news',
          subject: both('Otterdam in november', 'Otterdam in November'),
        },
      },
      blocks: [
        text({
          nl: [
            p('Beste otterliefhebber,'),
            p(
              'Deze winter bouwen we looprichels onder tien bruggen. Elke gift helpt, en vrienden lezen voortaan mee in de Leesclub.'
            ),
            p('Tot in maart, bij zonsopkomst aan het water.'),
          ],
          en: [
            p('Dear otter lover,'),
            p(
              'This winter we are building ledges under ten bridges. Every gift helps, and friends now read along in the Reading club.'
            ),
            p('See you in March, at sunrise by the water.'),
          ],
        }),
      ],
    }),
  },
];

/** Fictional people only; `+fail` would make a monthly charge fail at the fake provider. */
export const OTTERDAM_SUPPORTERS: SupporterDef[] = [
  {
    key: 'merel',
    email: 'merel.jansen@otterdam.example',
    joins: [
      { form: 'nieuwsbrief', consent: true },
      { form: 'petitie', consent: true },
    ],
    gives: [{ form: 'doneer', amount: 25 }],
  },
  {
    key: 'daan',
    email: 'daan.kok@otterdam.example',
    joins: [
      { form: 'petitie', consent: false },
      { form: 'otterspotten', consent: true },
    ],
  },
  {
    key: 'fatima',
    email: 'fatima.bakker@otterdam.example',
    gives: [{ form: 'doneer', amount: 10, interval: 'month' }],
    joins: [{ form: 'nieuwsbrief', consent: true }],
  },
  {
    key: 'tom',
    email: 'tom.smit@otterdam.example',
    locale: 'en',
    joins: [
      { form: 'nieuwsbrief', consent: true },
      { form: 'petitie', consent: false },
    ],
    writes: [
      {
        form: 'contact',
        values: {
          naam: 'Tom Smit',
          onderwerp: 'waarneming',
          plek: 'Brug bij de Kralingse Plas',
          datum: '2026-11-18',
          bericht: 'I saw an otter crossing the path at dusk, heading for the water.',
        },
      },
    ],
  },
  {
    key: 'ilse',
    email: 'ilse.mulder@otterdam.example',
    gives: [{ form: 'vrienden', values: { 'membership-interval': 'month' } }],
  },
  {
    key: 'lezer',
    email: 'lezer@otterdam.example',
    joins: [
      { form: 'nieuwsbrief', consent: true },
      { form: 'otterspotten', consent: true },
    ],
    reads: 'leesclub',
  },
  {
    key: 'kees',
    email: 'kees.dekker@otterdam.example',
    joins: [{ form: 'petitie', consent: false }],
    gives: [
      { form: 'doneer', amount: 50 },
      { form: 'doneer', amount: 100, interval: 'year' },
    ],
  },
];
