// `demo:site --definition` (MY-268): a definition in a directory outside this repository loads as
// a module or a directory, as a value or as a function of `@mycel/core/testing`, with its files
// beside it; against a real tenant it links to an article the tenant had before it (as an import
// leaves it) by slug, and a second run makes nothing. The database part skips without
// DATABASE_URL.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  memoryImageProcessor,
  memoryPlatform,
  runSuffix,
  seedSite,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '@mycel/db';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from '@mycel/db/testing';
import { loadDefinition } from './site-definition.js';

/** A definition as a private repository would keep it: helpers from the argument, not imports. */
const AS_FUNCTION = `
export default ({ rich }) => ({
  slug: 'kopie',
  name: 'Kopie',
  defaultLocale: 'nl',
  locales: ['nl'],
  footerText: { nl: 'Een kopie' },
  media: [], people: [], groups: [], sections: [], tiers: [], forms: [], patterns: [], campaigns: [],
  items: [{
    key: 'home',
    slug: 'home',
    document: (r) => ({
      type: 'page',
      title: { nl: 'Voorpagina' },
      defaultLocale: 'nl',
      locales: ['nl'],
      blocks: [rich.text({ nl: [rich.p('Lees ', rich.to('het verhaal', r.existing('verhaal')))] })],
    }),
  }],
});
`;

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycel-definition-'));
  await writeFile(join(dir, 'index.ts'), AS_FUNCTION);
  await writeFile(join(dir, 'value.ts'), `export default { slug: 'waarde', items: [] };\n`);
  await writeFile(join(dir, 'other.ts'), `export default { name: 'geen definitie' };\n`);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('loadDefinition', () => {
  it('loads index.ts of a directory, calling a function with the testing kit', async () => {
    const { site, files } = await loadDefinition(dir, '/');
    expect(site.slug).toBe('kopie');
    expect(files.href).toBe(pathToFileURL(`${dir}/`).href);
  });

  it('loads a module given by a path relative to where the command started', async () => {
    const { site, files } = await loadDefinition('value.ts', dir);
    expect(site.slug).toBe('waarde');
    expect(files.href).toBe(pathToFileURL(`${dir}/`).href);
  });

  it('refuses a module whose default export is not a definition', async () => {
    await expect(loadDefinition(join(dir, 'other.ts'), '/')).rejects.toThrow(
      'is not a site definition'
    );
  });
});

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('a definition from outside the repository, into a tenant', () => {
  const owner = createDb(operatorUrl);
  const app = createDb(appUrl);
  const invoker = new Invoker(
    buildRegistry(),
    createUnitOfWork(app, {
      clock: { now: () => new Date() },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
      media: { blobs: new MemoryBlobStore(), images: memoryImageProcessor },
    })
  );
  let tenant = '';
  const principal = () => systemPrincipal(tenant, 'seed');

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenant = (await testTenant(owner, `definition-${runSuffix()}`, { name: 'Kopie' })).id;
  });

  afterAll(async () => {
    await closeTenantWork(owner, [tenant]);
    await app.destroy();
    await owner.destroy();
  });

  it('links to an imported article by slug, and a second run makes nothing', async () => {
    const { item: imported } = await invoker.run(useCases.createItem, principal(), {
      slug: 'verhaal',
      document: {
        type: 'article',
        title: { nl: 'Verhaal' },
        defaultLocale: 'nl',
        locales: ['nl'],
        blocks: [],
      },
    });
    const { site, files } = await loadDefinition(dir, '/');
    const load = async () => new Uint8Array();

    const first = await seedSite(invoker, principal(), site, { load });
    expect(first.created).toEqual({ 'footer text': ['footer text'], item: ['home'] });
    const home = await invoker.run(useCases.getItem, principal(), {
      itemId: first.refs.item('home'),
    });
    expect(home.item.publication[0]?.status).toBe('published');
    expect(JSON.stringify(home.revision.document.blocks)).toContain(imported.id);
    expect(files.protocol).toBe('file:');

    const second = await seedSite(invoker, principal(), site, { load });
    expect(second.created).toEqual({});
  });
});
