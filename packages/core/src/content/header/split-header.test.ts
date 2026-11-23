// The split page header's button through the registry (MY-287, ADR 025 amended 2026-11-23): its
// item target is checked in the tenant's context like a block link, and the public projection
// carries it in the chosen locale. Apart from service.test.ts, which stands at its size ceiling.
import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { anonymousPrincipal, systemPrincipal, type Principal } from '../../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';

const page = () => ({
  type: 'page' as const,
  defaultLocale: 'nl',
  locales: ['nl'],
  title: { nl: 'Over ons' },
  blocks: [],
});
const split = (itemId: string) => ({
  ...page(),
  presentation: {
    header: 'split' as const,
    action: { label: { nl: 'Word actief' }, target: { kind: 'item' as const, itemId } },
  },
});

describe('the split page header button (MY-287)', () => {
  let invoker: Invoker;
  let admin: Principal;
  const visitor = () => anonymousPrincipal(TENANT, ['content:read', 'forms:read']);

  beforeEach(() => {
    invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork({ clock: new FakeClock() }));
    admin = systemPrincipal(TENANT, 'test');
  });

  const publish = async (slug: string, document: ReturnType<typeof page>) => {
    const { item, revision } = await invoker.run(useCases.createItem, admin, { slug, document });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    return item.id;
  };

  it("refuses another tenant's item as target, like a block link", async () => {
    const foreign = await invoker.run(useCases.createItem, systemPrincipal(OTHER, 't'), {
      slug: 'elders',
      document: page(),
    });
    await expect(
      invoker.run(useCases.createItem, admin, { slug: 'thuis', document: split(foreign.item.id) })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [{ path: 'presentation.action', message: 'content.reference.item-unknown' }],
    });
  });

  it('projects the button in the locale; a page without a choice has no presentation', async () => {
    const join = await publish('doe-mee', page());
    await publish('thuis', split(join));
    const home = await invoker.run(useCases.getPublished, visitor(), {
      type: 'page',
      slug: 'thuis',
    });
    expect(home.presentation).toEqual({
      header: 'split',
      action: { label: 'Word actief', target: { kind: 'item', itemId: join } },
    });
    expect(
      await invoker.run(useCases.getPublished, visitor(), { type: 'page', slug: 'doe-mee' })
    ).not.toHaveProperty('presentation');
  });
});
