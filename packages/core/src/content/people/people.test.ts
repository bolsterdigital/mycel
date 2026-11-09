// The shared page decision and group aggregate are domain behaviour, independent of a renderer.
import { describe, it, expect } from 'vitest';
import { Invoker } from '../../invoke.js';
import { systemPrincipal } from '../../principal.js';
import { MemoryUnitOfWork, TENANT } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { Person } from '../model.js';
import { personPageStatus } from './model.js';

describe('person register', () => {
  it('reads legacy authors without promoting an internal address or requiring link kinds', () => {
    const person = Person.parse({
      id: TENANT,
      slug: 'sam',
      name: 'Sam',
      email: 'private@example.org',
      links: [{ label: 'Site', url: 'https://example.org' }],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(person.pagePolicy).toBe('auto');
    expect(person.links[0]?.kind).toBe('other');
    expect(person.publicEmail).toBeUndefined();
  });
  it.each(['auto', 'always', 'never'] as const)(
    'site off wins over %s, with or without articles',
    (pagePolicy) => {
      for (const n of [0, 1])
        expect(personPageStatus({ personPages: 'off' }, { pagePolicy }, n)).toBe('site-off');
    }
  );
  it('requires an article for auto, while always and never remain explicit', () => {
    expect(personPageStatus({}, { pagePolicy: 'auto' }, 0)).toBe('no-articles');
    expect(personPageStatus({}, { pagePolicy: 'auto' }, 1)).toBe('enabled');
    expect(personPageStatus({}, { pagePolicy: 'always' }, 0)).toBe('enabled');
    expect(personPageStatus({}, { pagePolicy: 'never' }, 10)).toBe('never');
  });
  it('preserves the site page choice when an older client edits only the time zone', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const admin = systemPrincipal(TENANT, 'test');
    const first = await invoker.run(useCases.updateSiteGeneral, admin, {
      baseVersion: 0,
      general: { timeZone: 'UTC', personPages: 'off' },
    });
    const next = await invoker.run(useCases.updateSiteGeneral, admin, {
      baseVersion: first.version,
      general: { timeZone: 'Europe/Amsterdam' },
    });
    expect(next.value.personPages).toBe('off');
  });
  it('keeps membership order, rejects foreign people and refuses a stale group replacement', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const admin = systemPrincipal(TENANT, 'test');
    const a = await invoker.run(useCases.createPerson, admin, { slug: 'a', name: 'A' });
    const b = await invoker.run(useCases.createPerson, admin, { slug: 'b', name: 'B' });
    const group = await invoker.run(useCases.createPersonGroup, admin, {
      name: { en: 'Team' },
      personIds: [b.id, a.id],
    });
    expect(
      (await invoker.run(useCases.getPersonGroup, admin, { groupId: group.id })).personIds
    ).toEqual([b.id, a.id]);
    const next = await invoker.run(useCases.updatePersonGroup, admin, {
      groupId: group.id,
      baseUpdatedAt: group.updatedAt,
      name: group.name,
      personIds: [a.id],
    });
    await expect(
      invoker.run(useCases.updatePersonGroup, admin, {
        groupId: group.id,
        baseUpdatedAt: group.updatedAt,
        name: group.name,
        personIds: [b.id],
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await invoker.run(useCases.getPersonGroup, admin, { groupId: group.id })).toEqual(next);
    const foreign = systemPrincipal('01900000-0000-7000-8000-00000000bbbb', 'test');
    await expect(
      invoker.run(useCases.createPersonGroup, foreign, { name: { en: 'Other' }, personIds: [a.id] })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
