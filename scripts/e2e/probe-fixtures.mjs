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
