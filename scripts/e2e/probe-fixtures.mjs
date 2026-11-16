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
}
