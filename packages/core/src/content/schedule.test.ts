// Scheduled publishing in memory (ADR 018 rule 1, brief #8a § 4): the job publishes exactly the
// pinned revision, and every job of a cancelled or replaced plan is a no-op. `runJob` stands in
// for the worker: it runs the handler in a tenant unit of work and marks the job done, planning it
// again when the handler asks. The DB conformance runs the same scenarios through the real worker.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { parseJobPayload } from '../jobs/types.js';
import { systemPrincipal, type Principal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, pageDocument } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { publishScheduled } from './service.js';

const HOUR = 3_600_000;

const doc = (title: string) => pageDocument({ title: { nl: title, en: title } });

describe('scheduled publication', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let admin: Principal;
  let itemId: string;
  let a: string;

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    admin = systemPrincipal(TENANT, 'test');
    const created = await invoker.run(useCases.createItem, admin, {
      slug: 'news',
      document: doc('A'),
    });
    itemId = created.item.id;
    a = created.revision.id;
  });

  const at = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();
  const plan = (revisionId: string, locale: string, ms = HOUR) =>
    invoker.run(useCases.scheduleItem, admin, { itemId, revisionId, locale, at: at(ms) });
  const save = async (title: string) => {
    const { item } = await invoker.run(useCases.getItem, admin, { itemId });
    return (
      await invoker.run(useCases.updateItem, admin, {
        itemId,
        baseRevisionId: item.latestRevisionId,
        document: doc(title),
      })
    ).revision.id;
  };
  const state = async (locale: string) =>
    (await invoker.run(useCases.getItem, admin, { itemId })).item.publication.find(
      (s) => s.locale === locale
    )!;
  const openJobs = () => uow.store.jobs.filter((j) => j.doneAt === null);

  /** One worker pass over a job, like `runJobs`: handler, then done (and re-planned on `next`). */
  async function runJob(job = openJobs()[0]!) {
    const payload = parseJobPayload('content.publish', job.payload);
    const outcome = await uow.run(systemPrincipal(TENANT, 'jobs:content.publish'), (ctx) =>
      publishScheduled(ctx, payload)
    );
    job.doneAt = clock.now();
    if (outcome.next)
      uow.store.jobs.push({ ...job, id: `${job.id}+`, runAt: outcome.next, doneAt: null });
    return outcome;
  }

  it('pins revision A: a later save of B does not change what goes live', async () => {
    await plan(a, 'nl');
    const b = await save('B');
    clock.advance(HOUR);
    await runJob();
    const nl = await state('nl');
    expect(nl).toMatchObject({ status: 'published', publishedRevisionId: a, scheduleId: null });
    expect(nl.hasUnpublishedChanges).toBe(true);
    expect((await invoker.run(useCases.getItem, admin, { itemId })).item.latestRevisionId).toBe(b);
  });

  it('plans each locale on its own key and publishes them separately', async () => {
    await plan(a, 'nl', HOUR);
    await plan(a, 'en', 2 * HOUR);
    expect(new Set(openJobs().map((j) => j.key)).size).toBe(2);
    clock.advance(HOUR);
    const [nlJob, enJob] = openJobs();
    await runJob(nlJob);
    expect((await state('nl')).status).toBe('published');
    expect((await state('en')).status).toBe('scheduled');
    // Early: the en job asks to run again at the pinned time and publishes nothing yet.
    expect(await runJob(enJob)).toEqual({ next: new Date(clock.now().getTime() + HOUR) });
    expect((await state('en')).status).toBe('scheduled');
    clock.advance(HOUR);
    await runJob();
    expect((await state('en')).status).toBe('published');
  });

  it('re-pins the same revision at a new time: the old job is stale, the new one publishes', async () => {
    await plan(a, 'nl', HOUR);
    await plan(a, 'nl', 3 * HOUR);
    const [old, current] = openJobs();
    clock.advance(HOUR);
    expect(await runJob(old)).toEqual({});
    expect((await state('nl')).status).toBe('scheduled');
    clock.advance(2 * HOUR);
    await runJob(current);
    expect((await state('nl')).status).toBe('published');
  });

  it('unschedule leaves the job a no-op, and a live publication stays live', async () => {
    await invoker.run(useCases.publishItem, admin, { itemId, revisionId: a, locale: 'nl' });
    const b = await save('B');
    await plan(b, 'nl');
    expect((await state('nl')).status).toBe('published');
    await invoker.run(useCases.unscheduleItem, admin, { itemId, locale: 'nl' });
    clock.advance(HOUR);
    await runJob();
    expect(await state('nl')).toMatchObject({ status: 'published', publishedRevisionId: a });
  });

  it('a manual publish or unpublish before the job cancels the plan', async () => {
    await plan(a, 'nl');
    await invoker.run(useCases.unpublishItem, admin, { itemId, locale: 'nl' });
    clock.advance(HOUR);
    await runJob();
    expect((await state('nl')).status).toBe('draft');

    const b = await save('B');
    await plan(b, 'en');
    await invoker.run(useCases.publishItem, admin, { itemId, revisionId: a, locale: 'en' });
    clock.advance(HOUR);
    await runJob(openJobs().at(-1));
    expect((await state('en')).publishedRevisionId).toBe(a);
  });

  it('a second delivery of a job that already ran is a no-op', async () => {
    await plan(a, 'nl');
    const job = openJobs()[0]!;
    clock.advance(HOUR);
    await runJob(job);
    const first = await state('nl');
    clock.advance(HOUR);
    await runJob({ ...job, doneAt: null });
    expect(await state('nl')).toEqual(first);
  });

  it('only accepts a future time with an offset', async () => {
    await expect(plan(a, 'nl', -1)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      invoker.run(useCases.scheduleItem, admin, {
        itemId,
        revisionId: a,
        locale: 'nl',
        at: '2030-01-01T09:00:00',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
