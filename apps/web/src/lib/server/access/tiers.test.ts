// The tier screen's reads and writes go through the registry, so the capability and the tenant
// boundary are the use cases' own; these tests hold what the web layer adds: every page of the
// list, one locale edited with the others kept, and the refusals reaching the form unchanged.
import { describe, expect, it } from 'vitest';
import { Invoker, UseCaseError, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { MemoryUnitOfWork, TENANT, principal as member } from '@mycel/core/testing';
import { newTierFields, tierDirectory, tierFields } from './tiers.js';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const OTHER = '01900000-0000-7000-8000-00000000beef';

describe('access tiers in the admin (ADR 016 rule 2)', () => {
  it('walks beyond the first page and sorts by order, then slug', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const principal = systemPrincipal(TENANT, 'test');
    for (let i = 0; i < 101; i++)
      await invoker.run(useCases.createAccessTier, principal, {
        slug: `tier-${String(i).padStart(3, '0')}`,
        name: { en: `Tier ${i}` },
        order: 100 - i,
      });
    const tiers = await tierDirectory(principal, invoker);
    expect(tiers).toHaveLength(101);
    expect(tiers[0]!.slug).toBe('tier-100');
    expect(tiers.at(-1)!.slug).toBe('tier-000');
  });

  it('lists only the tiers of the principal own tenant', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    await invoker.run(useCases.createAccessTier, systemPrincipal(TENANT, 'test'), {
      slug: 'leden',
      name: { nl: 'Leden' },
    });
    expect(await tierDirectory(systemPrincipal(OTHER, 'test'), invoker)).toEqual([]);
  });

  it('refuses a write without content:publish and a read without content:read', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const writer = member({ capabilities: ['content:read', 'content:write'] });
    const refused = async (run: Promise<unknown>) =>
      run.then(
        () => 'ran',
        (e) => (e instanceof UseCaseError ? e.code : 'threw')
      );
    expect(
      await refused(
        invoker.run(useCases.createAccessTier, writer, { slug: 'leden', name: { nl: 'Leden' } })
      )
    ).toBe('forbidden');
    // The writer may list them, to choose one on an item.
    expect(await tierDirectory(writer, invoker)).toEqual([]);
    expect(await refused(tierDirectory(member({ capabilities: ['media:read'] }), invoker))).toBe(
      'forbidden'
    );
  });

  it('edits the shown locale and keeps the others', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const principal = systemPrincipal(TENANT, 'test');
    const tier = await invoker.run(useCases.createAccessTier, principal, {
      slug: 'leden',
      name: { nl: 'Leden', en: 'Members' },
      description: { en: 'For members' },
    });
    expect(
      tierFields(form({ name: ' Vrienden ', description: '', order: '4' }), 'nl', tier)
    ).toEqual({
      name: { nl: 'Vrienden', en: 'Members' },
      description: { en: 'For members' },
      order: 4,
      prices: {},
      signupPath: null,
    });
    // An emptied description in its only locale is no description at all.
    expect(tierFields(form({ name: 'Members', description: '', order: '0' }), 'en', tier)).toEqual({
      name: { nl: 'Leden', en: 'Members' },
      order: 0,
      prices: {},
      signupPath: null,
    });
  });

  it('reads the prices of a paid tier in euros and its signup page', () => {
    const read = tierFields(
      form({
        name: 'Vrienden',
        order: '0',
        'price-month': '5',
        'price-year': '€ 50,50',
        signupPath: ' /word-lid ',
      }),
      'nl'
    );
    expect(read).toMatchObject({ prices: { month: 500, year: 5050 }, signupPath: '/word-lid' });
    expect(tierFields(form({ name: 'x', 'price-month': 'vijf' }), 'nl').prices.month).toBeNaN();
  });

  it('gives a new tier a slug from its name and a free kind unless paid is chosen', () => {
    expect(newTierFields(form({ name: 'Vaste donateurs', slug: '' }))).toEqual({
      slug: 'vaste-donateurs',
      kind: 'free',
    });
    expect(newTierFields(form({ name: 'x', slug: 'steun', kind: 'paid' }))).toEqual({
      slug: 'steun',
      kind: 'paid',
    });
  });
});
