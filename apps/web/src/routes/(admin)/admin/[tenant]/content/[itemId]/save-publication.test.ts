// Exercise the real form actions and core with a save inserted after the screen's reads but
// before the update's item lock. Rejected: a sleep or a revision-provenance stub, which cannot
// prove that a no-op merge holds publication or that historical provenance is not this save.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Invoker, buildRegistry, useCases } from '@mycel/core';
import { FakeClock, MemoryUnitOfWork, principal } from '@mycel/core/testing';
import { valuesOf } from '#lib/server/content/content-admin.js';
import { actions } from './+page.server.js';

const state = vi.hoisted(() => ({ runtime: null as any, principal: null as any }));
vi.mock('#lib/server/runtime.js', () => ({ runtime: () => state.runtime }));
vi.mock('#lib/server/admin/admin.js', () => ({
  requireTenantPrincipal: async () => ({
    tenant: { slug: 'probe', defaultLocale: 'nl', locales: ['nl'] },
    principal: state.principal,
  }),
  adminTimeZone: async () => ({ zone: 'Europe/Amsterdam' }),
}));

const document = {
  type: 'page' as const,
  defaultLocale: 'nl',
  locales: ['nl'],
  title: { nl: 'Eerste versie' },
  blocks: [],
};

describe('save before a publication action', () => {
  let invoker: Invoker;
  beforeEach(() => {
    const clock = new FakeClock();
    invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork({ clock }));
    state.principal = principal({
      capabilities: ['content:read', 'content:write', 'content:publish'],
    });
    state.runtime = { invoker, clock };
  });

  const event = (
    itemId: string,
    baseRevisionId: string,
    doc: Parameters<typeof valuesOf>[0],
    action: string
  ) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(valuesOf(doc)))
      for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
    data.set('baseRevisionId', baseRevisionId);
    data.set('title.nl', 'Mijn titel');
    data.set('locale', 'nl');
    data.set('at.nl', '2030-01-04T09:00');
    const url = new URL(`http://admin.invalid/admin/probe/content/${itemId}?/${action}`);
    return {
      request: new Request(url, { method: 'POST', body: data }),
      url,
      params: { tenant: 'probe', itemId },
      locals: {},
      cookies: { get: () => undefined },
    } as any;
  };

  it.each(['publish', 'schedule', 'repin', 'approveTranslation'])(
    '%s is held when a no-op merge happens after the form reads',
    async (action) => {
      const { item, revision } = await invoker.run(useCases.createItem, state.principal, {
        slug: 'race',
        document,
      });
      const run = invoker.run.bind(invoker);
      let other: any;
      const calls: string[] = [];
      vi.spyOn(invoker, 'run').mockImplementation(async (uc, p, input) => {
        calls.push(uc.name);
        if (uc === useCases.updateItem && !other) {
          // commit() already read the base/latest; another writer lands before core's lock.
          other = await run(useCases.updateItem, p, {
            itemId: item.id,
            baseRevisionId: revision.id,
            document: {
              ...document,
              title: { nl: 'Mijn titel' },
              lead: { nl: 'Ongezien concept' },
            },
          });
        }
        return run(uc, p, input);
      });
      const outcome = await Promise.resolve(
        actions[action]!(event(item.id, revision.id, revision.document, action))
      ).catch((e: unknown) => e);
      expect(other).toBeDefined();
      expect(outcome).toMatchObject({
        status: 303,
        location: `/admin/probe/content/${item.id}?held&merged=${other.revision.id}`,
      });
      expect(calls).not.toContain('content.item.publish');
      expect(calls).not.toContain('content.item.schedule');
      expect(calls).not.toContain('content.translation.approve');
      const now = await run(useCases.getItem, state.principal, { itemId: item.id });
      expect(now.revision.id).toBe(other.revision.id);
      expect(now.revision.document.lead).toEqual({ nl: 'Ongezien concept' });
      expect(now.item.publication.every((p) => !p.publishedRevisionId && !p.scheduleId)).toBe(true);
      const { revisions } = await run(useCases.listRevisions, state.principal, { itemId: item.id });
      expect(revisions).toHaveLength(2);
    }
  );
  it('publishes on a current base even when that revision has historical merge provenance', async () => {
    const { item, revision } = await invoker.run(useCases.createItem, state.principal, {
      slug: 'current',
      document,
    });
    await invoker.run(useCases.updateItem, state.principal, {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: { ...document, lead: { nl: 'Concept van collega' } },
    });
    const merged = await invoker.run(useCases.updateItem, state.principal, {
      itemId: item.id,
      baseRevisionId: revision.id,
      document: { ...document, title: { nl: 'Samengevoegd' } },
    });
    expect(merged.revision.provenance).toHaveProperty('merged');
    await expect(
      actions.publish!(event(item.id, merged.revision.id, merged.revision.document, 'publish'))
    ).rejects.toMatchObject({
      status: 303,
      location: `/admin/probe/content/${item.id}?done=publish&locale=nl`,
    });
    const now = await invoker.run(useCases.getItem, state.principal, { itemId: item.id });
    expect(now.item.publication.find((p) => p.locale === 'nl')?.publishedRevisionId).toBe(
      now.revision.id
    );
    expect(now.revision.document.title.nl).toBe('Mijn titel');
    expect(now.revision.provenance).toBeUndefined();
  });
});
