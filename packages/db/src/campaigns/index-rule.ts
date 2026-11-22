// The campaign index of the overview scenario (MY-292): an overview with source `campaign` lists
// the landing pages of one kind that are published and public in the asked locale, never an
// archived campaign, a draft, another kind or another tenant, and each card says where its
// campaign stands. Run by `observeOverview` over the memory adapter and over Postgres. In a file
// of its own because the overview scenario and the adapter suite stand near their ceilings.

import { useCases, type Invoker, type Principal } from '@mycel/core';

interface Clock {
  advance(ms: number): void;
}

/**
 * Two petitions and a fundraiser published: the petition index shows exactly the two, newest
 * first; a third petition shows without touching the index; a closed one stays with its phase; a
 * hidden counter stays hidden; one taken offline in English leaves the English index only; a draft,
 * an archived one and another tenant's never show; a signup index with none is empty.
 */
export async function observeCampaignIndex(
  invoker: Invoker,
  admin: Principal,
  other: Principal,
  clock: Clock
) {
  const start = async (kind: 'petition' | 'signup' | 'fundraiser', slug: string, by = admin) => {
    clock.advance(1000);
    return invoker.run(useCases.composeCampaign, by, {
      kind,
      title: { nl: `Actie ${slug}`, en: `Campaign ${slug}` },
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      slug,
      goal: kind === 'fundraiser' ? null : { target: 100, milestones: [] },
    });
  };
  const publish = async (itemId: string, by = admin) => {
    const { item } = await invoker.run(useCases.getItem, by, { itemId });
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, by, {
        itemId,
        revisionId: item.latestRevisionId,
        locale,
      });
  };
  const launch = async (kind: 'petition' | 'signup' | 'fundraiser', slug: string, by = admin) => {
    const c = await start(kind, slug, by);
    await publish(c.landingItemId, by);
    return c;
  };
  const index = async (locale = 'nl', campaignKind: string = 'petition', by = admin) => {
    const { entries } = await invoker.run(useCases.getOverview, by, {
      props: { source: 'campaign', campaignKind: campaignKind as 'petition' },
      locale,
    });
    return entries
      .map((e) =>
        [
          e.slug,
          e.campaign?.phase ?? 'none',
          e.campaign?.counter
            ? `${e.campaign.counter.participants}/${e.campaign.counter.target}`
            : '-',
        ].join(':')
      )
      .join(' ');
  };

  const eerste = await launch('petition', 'eerste-petitie');
  await launch('fundraiser', 'inzameling');
  const tweede = await launch('petition', 'tweede-petitie');
  await start('petition', 'concept-petitie');
  await launch('petition', 'andermans-petitie', other);
  const twoPetitions = await index();
  const fundraisers = await index('nl', 'fundraiser');
  await launch('petition', 'derde-petitie');
  const afterThird = await index();

  // Closed, counter hidden, offline in English, then archived.
  const closed = await invoker.run(useCases.closeCampaign, admin, {
    campaignId: eerste.id,
    baseUpdatedAt: eerste.updatedAt,
  });
  await invoker.run(useCases.updateCampaign, admin, {
    campaignId: tweede.id,
    baseUpdatedAt: tweede.updatedAt,
    counterVisible: false,
  });
  await invoker.run(useCases.unpublishItem, admin, { itemId: tweede.landingItemId, locale: 'en' });
  const changed = { nl: await index('nl'), en: await index('en') };
  await invoker.run(useCases.archiveCampaign, admin, {
    campaignId: eerste.id,
    baseUpdatedAt: closed.updatedAt,
  });
  return {
    twoPetitions,
    fundraisers,
    afterThird,
    changed,
    archived: await index(),
    emptySignups: await index('nl', 'signup'),
    otherTenant: await index('nl', 'petition', other),
  };
}

export const expectedCampaignIndex = {
  // Newest first by first publication; not the draft, the fundraiser or the other tenant's.
  twoPetitions: 'tweede-petitie:upcoming:0/100 eerste-petitie:upcoming:0/100',
  // A fundraiser without a goal: its count, no target.
  fundraisers: 'inzameling:upcoming:0/null',
  afterThird:
    'derde-petitie:upcoming:0/100 tweede-petitie:upcoming:0/100 eerste-petitie:upcoming:0/100',
  changed: {
    nl: 'derde-petitie:upcoming:0/100 tweede-petitie:upcoming:- eerste-petitie:closed:0/100',
    en: 'derde-petitie:upcoming:0/100 eerste-petitie:closed:0/100',
  },
  archived: 'derde-petitie:upcoming:0/100 tweede-petitie:upcoming:-',
  emptySignups: '',
  otherTenant: 'andermans-petitie:upcoming:0/100',
};
