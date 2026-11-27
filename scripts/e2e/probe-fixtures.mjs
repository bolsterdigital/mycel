// Small fixtures of the probe tenant that e2e.mjs seeds after migrating, kept here so the
// runner stays under the file-size ceiling. Each one is idempotent: a rerun on the same database
// adds nothing. Rejected: growing e2e.mjs past 1,000 lines with a ceiling exemption.

/** Seeds the fixtures through the registry, as the system principal of the probe tenant. */
export async function probeFixtures(invoker, admin, useCases) {
  // A page published in nl only, whose en title and block are a draft marker.
  const draftCheck = { type: 'page', slug: 'draft-check' };
  if (!(await invoker.run(useCases.listItems, admin, draftCheck)).items.length) {
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: draftCheck.slug,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Alleen Nederlands live', en: 'EN-DRAFT-TITLE' },
        blocks: [
          { type: 'heading', version: 1, props: { text: { nl: 'Kop', en: 'EN-DRAFT-MARKER' } } },
        ],
      },
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
  }

  // Probe credits the work shown too, so media.spec.ts edits both credits.
  const images = await invoker.run(useCases.getSiteImages, admin, {});
  if (!images.value.workCredits)
    await invoker.run(useCases.updateSiteImages, admin, {
      baseVersion: images.version,
      images: { ...images.value, workCredits: true },
    });

  return { dossierId: await seedDossier(invoker, admin, useCases) };
}

/**
 * A dossier with one member, in nl and en (MY-260), so the examples `overview-dossier-members`
 * (its id stands in for `EXAMPLE_IDS.dossier`) and `overview-dossiers` render something, and the
 * member's page shows a dossier box. Returns the dossier's id.
 */
async function seedDossier(invoker, admin, useCases) {
  const publish = async ({ item, revision }) => {
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
    return item;
  };
  const find = async (type, slug) =>
    (await invoker.run(useCases.listItems, admin, { type, slug })).items[0];
  const doc = (type, nl, en, over = {}) => ({
    type,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl, en },
    blocks: [],
    ...over,
  });
  const dossier =
    (await find('page', 'e2e-dossier')) ??
    (await publish(
      await invoker.run(useCases.createItem, admin, {
        slug: 'e2e-dossier',
        document: doc('page', 'Betaalbaar wonen', 'Affordable housing', {
          profile: 'dossier',
          lead: { nl: 'Alles over wonen in de wijk.', en: 'All about housing in the area.' },
        }),
      })
    ));
  if (!(await find('article', 'e2e-dossier-lid')))
    await publish(
      await invoker.run(useCases.createItem, admin, {
        slug: 'e2e-dossier-lid',
        document: doc('article', 'Huren wordt duurder', 'Rents go up', {
          dossiers: [{ itemId: dossier.id }],
        }),
      })
    );
  return dossier.id;
}

/**
 * A campaign's landing page (ADR 038) with a given document: made through
 * `campaign.landing.create` like the admin's "New campaign", so the page is bound and places no
 * form block, then given the document as an update. Returns the item and the new revision.
 */
export async function landingPage(invoker, admin, useCases, kind, slug, document) {
  const campaign = await invoker.run(useCases.composeCampaign, admin, {
    kind,
    title: document.title,
    defaultLocale: document.defaultLocale,
    locales: document.locales,
    slug,
    goal: { target: 2500, milestones: [] },
  });
  const { revision } = await invoker.run(useCases.getItem, admin, {
    itemId: campaign.landingItemId,
  });
  return invoker.run(useCases.updateItem, admin, {
    itemId: campaign.landingItemId,
    baseRevisionId: revision.id,
    document,
  });
}

/** Opens participation of the campaign whose landing page `itemId` is. */
export async function openLanding(invoker, admin, useCases, itemId) {
  const { campaigns } = await invoker.run(useCases.listCampaigns, admin, { limit: 100 });
  const campaign = campaigns.find((c) => c.landingItemId === itemId);
  await invoker.run(useCases.openCampaign, admin, {
    campaignId: campaign.id,
    baseUpdatedAt: campaign.updatedAt,
  });
}

export async function seedSampleArticle(invoker, admin, useCases, uow) {
  // An article with an author and a section, published in nl and en, for public-site.spec.ts
  // for `/articles/<slug>`, its `/en/` twin, and the public metadata of the read route.
  const story = { type: 'article', slug: 'bomen-in-de-straat' };
  if (!(await invoker.run(useCases.listItems, admin, story)).items.length) {
    const [author, section] = await uow.run(admin, async (ctx) => [
      await ctx.authors.findBySlug('e2e-auteur'),
      await ctx.sections.findBySlug('e2e-stad'),
    ]);
    const authorId = (
      author ??
      (await invoker.run(useCases.createPerson, admin, {
        slug: 'e2e-auteur',
        name: 'Sam de Vries',
        email: 'sam@probe.test',
        publicEmail: 'public-sam@probe.test',
        bio: { nl: 'Sam schrijft over de stad.', en: 'Sam writes about the city.' },
        role: { nl: 'Redacteur', en: 'Editor' },
        links: [{ label: 'Website', url: 'https://example.org/sam' }],
      }))
    ).id;
    const sectionId = (
      section ??
      (await invoker.run(useCases.createSection, admin, {
        slug: 'e2e-stad',
        title: { nl: 'Stad', en: 'City' },
      }))
    ).id;
    const paragraph = (text) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: story.slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Bomen in de straat', en: 'Trees in the street' },
        lead: {
          nl: 'Waarom de buurt meer groen wil.',
          en: 'Why the neighbourhood wants more green.',
        },
        authorIds: [authorId],
        sectionId,
        blocks: [
          {
            type: 'rich-text',
            version: 1,
            props: {
              content: {
                nl: paragraph('Schaduw, koelte en ruimte voor water.'),
                en: paragraph('Shade, cool air and room for water.'),
              },
            },
          },
        ],
      },
    });
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
  }
}

export async function seedManagedVideo({
  uow,
  admin,
  id,
  posterId,
  libraryId,
  recording,
  videoSourceKey,
}) {
  // Three lines, one with a speaker: the read-along (MY-305) seeks between them and names who
  // speaks. A database seeded before then gets these tracks too.
  const publishedTracks = {
    nl: 'WEBVTT\n\n00:00.000 --> 00:02.000\nLangs de rivier.\n\n00:02.000 --> 00:04.000\n<v Sam>Een otter zwemt.\n\n00:04.000 --> 00:05.000\n[water]\n',
    en: 'WEBVTT\n\n00:00.000 --> 00:02.000\nAlong the river.\n\n00:02.000 --> 00:04.000\n<v Sam>An otter swims.\n\n00:04.000 --> 00:05.000\n[water]\n',
  };
  await uow.run(admin, async ({ videos }) => {
    const existing = await videos.get(id);
    if (existing && JSON.stringify(existing.publishedTracks) !== JSON.stringify(publishedTracks))
      await videos.update(id, { publishedTracks });
    if (!existing)
      await videos.insert({
        id: id,
        posterId: posterId,
        durationSeconds: 54,
        hasSource: false,
        metadata: {
          title: { nl: 'Een opname', en: 'A recording' },
          maker: 'Mycel',
          licence: { code: 'cc0' },
          watchUrl: 'https://example.com/river',
        },
        publishedTracks,
        createdAt: new Date(),
        trashedAt: null,
      });
  });
  await uow.run(admin, async ({ videos, blobs, media }) => {
    if ((await videos.upload(id))?.state === 'ready') return;
    const key = videoSourceKey(admin.tenantId, id);
    await blobs.put(key, recording, { contentType: 'video/mp4' });
    await media.replaceUsages(`video:${id}`, [{ mediaId: posterId, blockId: 'poster' }]);
    await videos.update(id, { hasSource: true });
    await videos.saveUpload({
      videoId: id,
      uploadKey: id,
      libraryId: libraryId,
      providerId: id,
      mp4Height: 180,
      storageBytes: 10000,
      durationSeconds: 5,
      state: 'ready',
    });
  });
}
