// Otterdam's register (ADR 031): six fictional team members, three fictional partner
// organisations, two groups, the sections and the forms. No real names, addresses or bodies: the
// people are made up, and so are the partners, so no real water board or municipality appears.
// The portraits are otter photographs: a demo has no right to anyone's face.

import type { FormDef, GroupDef, PersonDef, SectionDef } from '../runner.js';

export const OTTERDAM_PEOPLE: PersonDef[] = [
  {
    key: 'anouk',
    slug: 'anouk-de-ruiter',
    image: 'portret',
    person: {
      name: 'Anouk de Ruiter',
      role: { nl: 'Directeur', en: 'Director' },
      bio: {
        nl: 'Anouk richtte Otterdam in 2019 op, na tien jaar als bioloog bij een natuurorganisatie. Ze gelooft dat een stad en een otter prima samengaan, als de stad er een beetje rekening mee houdt.',
        en: 'Anouk founded Otterdam in 2019, after ten years as a biologist with a nature charity. She believes a city and an otter get along fine, as long as the city makes a little room.',
      },
      publicEmail: 'anouk@otterdam.example',
      links: [
        { label: 'Bluesky', url: 'https://bsky.app/profile/otterdam.example', kind: 'bluesky' },
      ],
    },
  },
  {
    key: 'joris',
    slug: 'joris-van-der-meer',
    image: 'oever',
    person: {
      name: 'Joris van der Meer',
      role: { nl: 'Ecoloog', en: 'Ecologist' },
      bio: {
        nl: 'Joris leidt het onderzoek: waar zitten de otters, wat eten ze en waar lopen ze gevaar. Hij kent elke vistrap tussen Biesbosch en Nieuwe Waterweg.',
        en: 'Joris leads the research: where the otters live, what they eat and where they are at risk. He knows every fish pass between the Biesbosch and the Nieuwe Waterweg.',
      },
    },
  },
  {
    key: 'samira',
    slug: 'samira-el-idrissi',
    image: 'kijken',
    person: {
      name: 'Samira el Idrissi',
      role: { nl: 'Campagneleider', en: 'Campaign lead' },
      bio: {
        nl: 'Samira zorgt dat wat Joris meet, ook bij beslissers aankomt. Ze schreef de petitie voor veilige vistrappen.',
        en: 'Samira makes sure that what Joris measures reaches the people who decide. She wrote the petition for safe fish passes.',
      },
    },
  },
  {
    key: 'pieter',
    slug: 'pieter-bos',
    person: {
      name: 'Pieter Bos',
      role: { nl: 'Coördinator vrijwilligers', en: 'Volunteer coordinator' },
      bio: {
        nl: 'Pieter plant de telrondes en de opruimacties, en weet altijd wie er nog een waadpak over heeft.',
        en: 'Pieter plans the counts and the clean-ups, and always knows who has a spare pair of waders.',
      },
    },
  },
  {
    key: 'lotte',
    slug: 'lotte-visser',
    image: 'drinkt',
    person: {
      name: 'Lotte Visser',
      role: { nl: 'Communicatie en redactie', en: 'Communications and editing' },
      bio: {
        nl: 'Lotte schrijft de nieuwsbrief en maakt de podcast. Ze fotografeert ook, maar otters zijn lastige modellen.',
        en: 'Lotte writes the newsletter and makes the podcast. She takes photos too, but otters are difficult models.',
      },
    },
  },
  {
    key: 'ravi',
    slug: 'ravi-ramdin',
    person: {
      name: 'Ravi Ramdin',
      role: { nl: 'Penningmeester', en: 'Treasurer' },
      bio: {
        nl: 'Ravi houdt de boeken bij en legt elk jaar verantwoording af in het jaarverslag.',
        en: 'Ravi keeps the books and accounts for every euro in the annual report.',
      },
    },
  },
  {
    key: 'natte-natuur',
    slug: 'stichting-natte-natuur',
    person: {
      kind: 'organisation',
      name: 'Stichting Natte Natuur',
      bio: {
        nl: 'Beheert drie moerasgebieden in de Maasdelta en deelt haar waarnemingen met ons.',
        en: 'Manages three marshes in the Maas delta and shares its sightings with us.',
      },
      links: [{ label: 'Website', url: 'https://natte-natuur.example/', kind: 'website' }],
    },
  },
  {
    key: 'hengelaars',
    slug: 'hengelclub-de-snoek',
    person: {
      kind: 'organisation',
      name: 'Hengelclub De Snoek',
      bio: {
        nl: 'Vissers die met ons fuiken otterveilig maken: een stopnet kost een paar euro.',
        en: 'Anglers who help us make fyke nets otter-safe: a stop grid costs a few euros.',
      },
    },
  },
  {
    key: 'leerlingen',
    slug: 'natuurlab-zuid',
    person: {
      kind: 'organisation',
      name: 'Natuurlab Zuid',
      bio: {
        nl: 'Een netwerk van basisscholen dat met ons sporen zoekt langs de singels.',
        en: 'A network of primary schools that looks for tracks with us along the canals.',
      },
    },
  },
];

export const OTTERDAM_GROUPS: GroupDef[] = [
  {
    key: 'team',
    name: { nl: 'Team', en: 'Team' },
    people: ['anouk', 'joris', 'samira', 'pieter', 'lotte', 'ravi'],
  },
  { key: 'bestuur', name: { nl: 'Bestuur', en: 'Board' }, people: ['anouk', 'ravi'] },
];

export const OTTERDAM_SECTIONS: SectionDef[] = [
  {
    key: 'nieuws',
    slug: 'nieuws',
    title: { nl: 'Nieuws', en: 'News' },
    description: { nl: 'Wat er speelt rond de otters in en om Rotterdam.' },
  },
  { key: 'onderzoek', slug: 'onderzoek', title: { nl: 'Onderzoek', en: 'Research' } },
  { key: 'campagnes', slug: 'campagnes', title: { nl: 'Campagnes', en: 'Campaigns' } },
  { key: 'achtergrond', slug: 'achtergrond', title: { nl: 'Achtergrond', en: 'Background' } },
  { key: 'op-pad', slug: 'op-pad', title: { nl: 'Op pad', en: 'Out and about' } },
  {
    key: 'test',
    slug: 'test',
    title: { nl: 'Test' },
    description: { nl: 'Testmateriaal om Mycel te proeven; geen echte berichten.' },
  },
  {
    key: 'leeg',
    slug: 'test-lege-rubriek',
    title: { nl: 'Test: lege rubriek' },
    description: { nl: 'Een rubriek zonder artikelen, om te zien wat een lezer dan ziet.' },
  },
];

export const OTTERDAM_FORMS: FormDef[] = [
  { key: 'contact', kind: 'contact', name: { nl: 'Contactformulier', en: 'Contact form' } },
  {
    key: 'nieuwsbrief',
    kind: 'signup',
    name: { nl: 'Nieuwsbrief Otterdam', en: 'Otterdam newsletter' },
  },
  {
    key: 'petitie',
    kind: 'petition',
    name: { nl: 'Petitie veilige vistrappen', en: 'Petition safe fish passes' },
  },
];
