// The admin's site import over the memory store (MY-257 PR 3): the WordPress planner gives the
// dry run on upload, the `content.import` job runs it through the registry and records what it
// made, a failure lands on the row instead of failing the job, and a download reaches only a
// public address. The run against Postgres is wordpress.test.ts (PR 2); the row in packages/db.

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, useCases } from '@mycel/core';
import {
  FakeDns,
  MemoryBlobStore,
  MemoryUnitOfWork,
  TENANT,
  memoryImageProcessor,
  principal,
} from '@mycel/core/testing';
import { publicFetch, runContentImport, wordpressPlanner } from './wordpress.js';

const FIXTURE = new URL('../../../import-wordpress/fixtures/dreamkit-export.xml', import.meta.url);
const UPLOADS = new URL('../../../import-wordpress/fixtures/uploads/', import.meta.url);

/** The export's own host, answered from the fixture's uploads; anything else is a 404. */
const fixtureFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/wp-content\/uploads\//, '');
  try {
    return new Response(await readFile(new URL(path, UPLOADS)), { status: 200 });
  } catch {
    return new Response(null, { status: 404 });
  }
}) as typeof fetch;

function setup() {
  const uow = new MemoryUnitOfWork({
    importPlanner: wordpressPlanner,
    blobs: new MemoryBlobStore(),
    images: memoryImageProcessor,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = principal();
  const identity = {
    tenantAccess: async () => ({ entitlements: admin.entitlements, status: admin.status }),
  };
  const run = (id: string) =>
    runContentImport({ uow, invoker, identity, fetch: fixtureFetch }, TENANT, id);
  const upload = (xml: string, intoExisting = false) =>
    invoker.run(useCases.uploadImport, admin, {
      fileName: 'dreamkit-export.xml',
      bytes: Buffer.from(xml).toString('base64'),
      intoExisting,
    });
  return { uow, invoker, admin, run, upload };
}

describe('content.import with the WordPress importer', () => {
  const xml = readFileSync(FIXTURE, 'utf8');

  it('plans on upload, runs once in the job and records what it made', async () => {
    const { invoker, admin, run, upload } = setup();
    const planned = await upload(xml);
    expect(planned.summary.site.url).toBe('https://voorbeeld.example');
    expect(planned.summary.counts.articles).toBeGreaterThan(0);
    expect(planned.summary.lines.some((l) => l.code === 'block.skipped')).toBe(true);
    await invoker.run(useCases.confirmImport, admin, { importId: planned.id });
    await run(planned.id);
    const [done] = (await invoker.run(useCases.listImports, admin, {})).imports;
    expect(done).toMatchObject({ status: 'done', error: null });
    const { items } = await invoker.run(useCases.listItems, admin, { limit: 100 });
    expect(done?.outcome?.items.map((i) => i.itemId).sort()).toEqual(items.map((i) => i.id).sort());
    expect(items.length).toBe(planned.summary.counts.pages + planned.summary.counts.articles);
    expect(done?.outcome?.lines.filter((l) => l.code === 'media.failed')).toEqual([]);
    // The job again, as a retry would: nothing happens twice.
    await run(planned.id);
    expect((await invoker.run(useCases.listItems, admin, { limit: 100 })).items).toHaveLength(
      items.length
    );
  });

  it('records a refusal on the row: a site with content needs "into existing"', async () => {
    const { invoker, admin, run, upload } = setup();
    const first = await upload(xml);
    await invoker.run(useCases.confirmImport, admin, { importId: first.id });
    await run(first.id);
    const second = await upload(xml);
    await invoker.run(useCases.confirmImport, admin, { importId: second.id });
    await run(second.id);
    const [failed] = (await invoker.run(useCases.listImports, admin, {})).imports;
    expect(failed).toMatchObject({ id: second.id, status: 'failed', outcome: null });
    expect(failed?.error).toMatch(/already has \d+ item/);
  });

  it('refuses an upload that is no WordPress export', async () => {
    const { upload } = setup();
    await expect(upload('<html><body>no</body></html>')).rejects.toMatchObject({
      code: 'invalid_input',
      issues: [{ path: 'bytes', message: 'import.file.unreadable' }],
    });
  });
});

describe('publicFetch', () => {
  const dns = new FakeDns({
    'intern.example': ['10.0.0.5'],
    'mixed.example': ['8.8.8.8', '127.0.0.1'],
  });
  const get = publicFetch(dns);

  it.each([
    ['a private answer', 'https://intern.example/wp-content/uploads/a.jpg'],
    ['one private answer among public ones', 'https://mixed.example/a.jpg'],
    ['an address literal', 'https://127.0.0.1/a.jpg'],
    ['plain http', 'http://mixed.example/a.jpg'],
    ['another port', 'https://mixed.example:8443/a.jpg'],
    ['a name without an answer', 'https://unknown.example/a.jpg'],
  ])('refuses %s before any connection', async (_, url) => {
    await expect(get(url)).rejects.toThrow(/not a public https address/);
  });
});
