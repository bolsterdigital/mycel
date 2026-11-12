// The campaign rules of ADR 033 over the memory adapter: binding (rules 1 and 3), the public
// landing page (rule 5), archive and trash (rule 9) and the capability split (rule 10).
// `packages/db/src/campaigns.test.ts` holds the Postgres adapter to the same keys and the tenant
// boundary.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import type { Capability, Principal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, expectCode, principal } from '../testing/index.js';
import { exampleId } from '../util/ids.js';
import { buildRegistry, useCases } from '../use-cases.js';

const TENANT_B = exampleId(0xbbbb);
const doc = (type: 'page' | 'article', title: string, access?: unknown) => ({
  type,
  defaultLocale: 'nl',
  locales: ['nl'],
  title: { nl: title },
  blocks: [],
  ...(access ? { access } : {}),
});
const MEMBERS = { level: 'members', teaser: { blocks: 0 } };

function setup() {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = principal({
    capabilities: ['content:read', 'content:write', 'content:publish', 'forms:write'],
  });
  const as = (capabilities: Capability[], tenantId = TENANT): Principal =>
    principal({ capabilities, tenantId });
  const writer = as(['content:read', 'content:write', 'forms:write']);
  const page = async (slug: string, type: 'page' | 'article' = 'page', p = admin) =>
    (
      await invoker.run(useCases.createItem, p, {
        slug,
        document: doc(type, slug) as never,
      })
    ).item;
  const form = (kind: 'petition' | 'signup' | 'contact' = 'petition', p = admin) =>
    invoker.run(useCases.createForm, p, { kind });
  const campaign = async (slug = 'teken', kind: 'petition' | 'signup' = 'petition') => {
    const landing = await page(slug);
    const f = await form(kind);
    return invoker.run(useCases.createCampaign, admin, {
      kind,
      landingItemId: landing.id,
      formId: f.id,
    });
  };
  return { clock, uow, invoker, admin, writer, as, page, form, campaign };
}

describe('a campaign (ADR 033)', () => {
  it('binds a page and a form of its kind and starts as a closed draft', async () => {
    const { invoker, admin, page, form } = setup();
    const landing = await page('red-de-bomen');
    const f = await form('petition');
    const created = await invoker.run(useCases.createCampaign, admin, {
      kind: 'petition',
      landingItemId: landing.id,
      formId: f.id,
      goal: { target: 1000, milestones: [100, 500] },
    });
    expect(created).toMatchObject({
      kind: 'petition',
      landingItemId: landing.id,
      formId: f.id,
      participation: { state: 'draft', opensAt: null, closesAt: null },
      goal: { target: 1000, milestones: [100, 500] },
      counterVisible: true,
      erasedCount: 0,
      archivedAt: null,
    });
    expect(await invoker.run(useCases.getCampaign, admin, { campaignId: created.id })).toEqual(
      created
    );
    const { campaigns } = await invoker.run(useCases.listCampaigns, admin, {});
    expect(campaigns.map((c) => c.id)).toEqual([created.id]);
  });

  it('refuses an article, a bound page, a missing page and a restricted page as landing page', async () => {
    const { invoker, admin, page, campaign } = setup();
    const article = await page('nieuws', 'article');
    await expectCode(
      invoker.run(useCases.createCampaign, admin, { kind: 'signup', landingItemId: article.id }),
      'invalid_input',
      'campaign.landing.not-a-page'
    );
    const first = await campaign('eerste');
    await expectCode(
      invoker.run(useCases.createCampaign, admin, {
        kind: 'signup',
        landingItemId: first.landingItemId,
      }),
      'conflict',
      'campaign.landing.bound'
    );
    await expectCode(
      invoker.run(useCases.createCampaign, admin, {
        kind: 'signup',
        landingItemId: exampleId(0x404),
      }),
      'not_found'
    );
    const closed = (
      await invoker.run(useCases.createItem, admin, {
        slug: 'leden',
        document: doc('page', 'Leden', MEMBERS) as never,
      })
    ).item;
    await expectCode(
      invoker.run(useCases.createCampaign, admin, { kind: 'signup', landingItemId: closed.id }),
      'conflict',
      'campaign.landing.restricted'
    );
  });

  it('binds a form only of the matching kind, only once and only with forms:write', async () => {
    const { invoker, admin, writer, page, form, campaign } = setup();
    const contact = await form('contact');
    await expectCode(
      invoker.run(useCases.createCampaign, admin, {
        kind: 'petition',
        landingItemId: (await page('a')).id,
        formId: contact.id,
      }),
      'invalid_input',
      'campaign.form.kind-mismatch'
    );
    const signup = await form('signup');
    await expectCode(
      invoker.run(useCases.createCampaign, admin, {
        kind: 'fundraiser',
        landingItemId: (await page('b')).id,
        formId: signup.id,
      }),
      'invalid_input',
      'campaign.form.kind-mismatch'
    );
    const bound = await campaign('c');
    await expectCode(
      invoker.run(useCases.createCampaign, admin, {
        kind: 'petition',
        landingItemId: (await page('d')).id,
        formId: bound.formId,
      }),
      'conflict',
      'campaign.form.bound'
    );
    const free = await form('petition');
    const withoutForms = principal({ capabilities: ['content:read', 'content:write'] });
    await expectCode(
      invoker.run(useCases.createCampaign, withoutForms, {
        kind: 'petition',
        landingItemId: (await page('e')).id,
        formId: free.id,
      }),
      'forbidden',
      'campaign.forbidden.forms-write'
    );
    // Without a form a write-only principal may still create the draft.
    const draft = await invoker.run(useCases.createCampaign, writer, {
      kind: 'petition',
      landingItemId: (await page('f')).id,
    });
    expect(draft.formId).toBeNull();
  });

  it('keeps its landing page public and out of the trash until archived (rules 5 and 9)', async () => {
    const { invoker, admin, campaign } = setup();
    const c = await campaign('blijft-open');
    const { revision } = await invoker.run(useCases.getItem, admin, { itemId: c.landingItemId });
    await expectCode(
      invoker.run(useCases.updateItem, admin, {
        itemId: c.landingItemId,
        baseRevisionId: revision.id,
        document: { ...revision.document, access: MEMBERS } as never,
      }),
      'conflict',
      'campaign.landing.restricted'
    );
    await expectCode(
      invoker.run(useCases.deleteItem, admin, { itemId: c.landingItemId }),
      'conflict',
      'content.delete.campaign-landing'
    );
    await invoker.run(useCases.archiveCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: c.updatedAt,
    });
    await invoker.run(useCases.deleteItem, admin, { itemId: c.landingItemId });
    // Archived and trashed: the campaign stays, with its page id, for the record.
    expect(
      (await invoker.run(useCases.getCampaign, admin, { campaignId: c.id })).landingItemId
    ).toBe(c.landingItemId);
  });

  it('opens and closes participation without touching publication', async () => {
    const { invoker, admin, campaign } = setup();
    const c = await campaign();
    const opened = await invoker.run(useCases.openCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: c.updatedAt,
    });
    expect(opened.participation.state).toBe('open');
    const page = await invoker.run(useCases.getItem, admin, { itemId: c.landingItemId });
    expect(page.item.publication.every((p) => p.status === 'draft')).toBe(true);
    const closed = await invoker.run(useCases.closeCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: opened.updatedAt,
    });
    expect(closed.participation.state).toBe('closed');
    await expectCode(
      invoker.run(useCases.openCampaign, admin, {
        campaignId: c.id,
        baseUpdatedAt: opened.updatedAt,
      }),
      'conflict',
      'campaign.conflict'
    );
  });

  it('refuses to open without a form, and a fundraiser before ADR 005', async () => {
    const { invoker, admin, page } = setup();
    const noForm = await invoker.run(useCases.createCampaign, admin, {
      kind: 'signup',
      landingItemId: (await page('zonder')).id,
    });
    await expectCode(
      invoker.run(useCases.openCampaign, admin, {
        campaignId: noForm.id,
        baseUpdatedAt: noForm.updatedAt,
      }),
      'conflict',
      'campaign.form.required'
    );
    const fund = await invoker.run(useCases.createCampaign, admin, {
      kind: 'fundraiser',
      landingItemId: (await page('geld')).id,
    });
    await expectCode(
      invoker.run(useCases.openCampaign, admin, {
        campaignId: fund.id,
        baseUpdatedAt: fund.updatedAt,
      }),
      'conflict',
      'campaign.kind.not-available'
    );
  });

  it('lets content:write edit everything but the window and the state (rule 10)', async () => {
    const { invoker, writer, campaign } = setup();
    const c = await campaign();
    const at = { campaignId: c.id, baseUpdatedAt: c.updatedAt };
    for (const useCase of [useCases.openCampaign, useCases.closeCampaign, useCases.archiveCampaign])
      await expectCode(invoker.run(useCase, writer, at), 'forbidden');
    await expectCode(
      invoker.run(useCases.updateCampaign, writer, {
        ...at,
        window: { opensAt: null, closesAt: '2026-12-01T00:00:00.000Z' },
      }),
      'forbidden',
      'campaign.forbidden.content-publish'
    );
    // The same window again, written differently, is no change; the rest of the update passes.
    const updated = await invoker.run(useCases.updateCampaign, writer, {
      ...at,
      counterVisible: false,
      goal: { target: 50 },
      window: { opensAt: null, closesAt: null },
    });
    expect(updated).toMatchObject({ counterVisible: false, goal: { target: 50, milestones: [] } });
    expect(updated.participation).toEqual(c.participation);
  });

  it('moves the window with content:publish and refuses an end before the start', async () => {
    const { invoker, admin, campaign } = setup();
    const c = await campaign();
    const window = { opensAt: '2026-12-01T00:00:00+01:00', closesAt: '2027-01-01T00:00:00Z' };
    const moved = await invoker.run(useCases.updateCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: c.updatedAt,
      window,
    });
    expect(moved.participation).toMatchObject({ state: 'draft', ...window });
    await expectCode(
      invoker.run(useCases.updateCampaign, admin, {
        campaignId: c.id,
        baseUpdatedAt: moved.updatedAt,
        window: { opensAt: '2027-02-01T00:00:00Z', closesAt: '2027-01-01T00:00:00Z' },
      }),
      'invalid_input'
    );
  });

  it('refuses an update on an old base and keeps the form while open', async () => {
    const { invoker, admin, campaign } = setup();
    const c = await campaign();
    const first = await invoker.run(useCases.updateCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: c.updatedAt,
      counterVisible: false,
    });
    await expectCode(
      invoker.run(useCases.updateCampaign, admin, {
        campaignId: c.id,
        baseUpdatedAt: c.updatedAt,
        counterVisible: true,
      }),
      'conflict',
      'campaign.conflict'
    );
    const opened = await invoker.run(useCases.openCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: first.updatedAt,
    });
    await expectCode(
      invoker.run(useCases.updateCampaign, admin, {
        campaignId: c.id,
        baseUpdatedAt: opened.updatedAt,
        formId: null,
      }),
      'conflict',
      'campaign.form.required-while-open'
    );
  });

  it('archives by closing, leaves the list and refuses later writes', async () => {
    const { invoker, admin, campaign } = setup();
    const c = await campaign();
    const opened = await invoker.run(useCases.openCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: c.updatedAt,
    });
    const archived = await invoker.run(useCases.archiveCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: opened.updatedAt,
    });
    expect(archived.participation.state).toBe('closed');
    expect(archived.archivedAt).not.toBeNull();
    expect((await invoker.run(useCases.listCampaigns, admin, {})).campaigns).toEqual([]);
    expect(
      (await invoker.run(useCases.listCampaigns, admin, { archived: true })).campaigns
    ).toEqual([archived]);
    for (const useCase of [useCases.openCampaign, useCases.archiveCampaign])
      await expectCode(
        invoker.run(useCase, admin, { campaignId: c.id, baseUpdatedAt: archived.updatedAt }),
        'conflict',
        'campaign.archived'
      );
  });

  it('refuses to archive while a published item shows it, naming that item (rule 9)', async () => {
    const { uow, invoker, admin, page, campaign } = setup();
    const c = await campaign();
    const host = await page('home');
    const { revision } = await invoker.run(useCases.getItem, admin, { itemId: host.id });
    // No block records a campaign reference before the campaign card exists; the read model is what
    // archive consults, so the test writes the row the card will write.
    uow.store
      .for(TENANT)
      .blockRefs.set(revision.id, [{ blockId: 'card', type: 'campaign', refId: c.id }]);
    const at = { campaignId: c.id, baseUpdatedAt: c.updatedAt };
    await invoker.run(useCases.publishItem, admin, {
      itemId: host.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    const refused = await expectCode(
      invoker.run(useCases.archiveCampaign, admin, at),
      'conflict',
      'campaign.archive.referenced'
    );
    expect(refused.issues[0]?.params).toEqual({ count: '1', titles: 'home' });
    // Once the host is offline the reference no longer holds it back.
    await invoker.run(useCases.unpublishItem, admin, { itemId: host.id, locale: 'nl' });
    await invoker.run(useCases.archiveCampaign, admin, at);
  });

  it("is invisible to another tenant, which cannot bind this tenant's page or form", async () => {
    const { invoker, as, page, form, campaign } = setup();
    const c = await campaign();
    const b = as(['content:read', 'content:write', 'content:publish', 'forms:write'], TENANT_B);
    await expectCode(invoker.run(useCases.getCampaign, b, { campaignId: c.id }), 'not_found');
    expect((await invoker.run(useCases.listCampaigns, b, {})).campaigns).toEqual([]);
    await expectCode(
      invoker.run(useCases.openCampaign, b, { campaignId: c.id, baseUpdatedAt: c.updatedAt }),
      'not_found'
    );
    await expectCode(
      invoker.run(useCases.createCampaign, b, { kind: 'petition', landingItemId: c.landingItemId }),
      'not_found'
    );
    const own = await page('eigen', 'page', b);
    const aForm = await form('petition');
    await expectCode(
      invoker.run(useCases.createCampaign, b, {
        kind: 'petition',
        landingItemId: own.id,
        formId: aForm.id,
      }),
      'not_found'
    );
  });
});
