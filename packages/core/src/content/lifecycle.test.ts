// Property test for the publication state machine (testing.md: state machines get property
// tests). Random sequences of saves, publications, plans and job runs over two locales, checked
// after every step against invariants that no sequence may break.
//
// A seeded generator instead of fast-check: thirty lines cover what this test needs, and a
// failing seed is printed so the sequence replays exactly (ADR 008 policy 1). Rejected:
// adding fast-check for one test file.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { parseJobPayload } from '../jobs/types.js';
import { systemPrincipal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { publishScheduled } from './service.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const LOCALES = ['nl', 'en'] as const;

/** mulberry32: small, fast, and good enough to drive a test. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runSequence(seed: number, steps: number): Promise<void> {
  const rnd = random(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(TENANT, 'property');
  const document = (n: number) => ({
    type: 'page' as const,
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: `nl ${n}`, en: `en ${n}` },
    blocks: [],
  });
  const created = await invoker.run(useCases.createItem, admin, {
    slug: 'p',
    document: document(0),
  });
  const itemId = created.item.id;
  const revisions = [created.revision.id];
  /** What each locale's live revision must be, from the operations alone. */
  const expected = new Map<string, string | null>(LOCALES.map((l) => [l, null]));
  const plans = new Map<string, { revisionId: string; at: number } | null>(
    LOCALES.map((l) => [l, null])
  );

  const ops = ['save', 'publish', 'unpublish', 'schedule', 'unschedule', 'tick'] as const;
  for (let step = 0; step < steps; step++) {
    const locale = pick(LOCALES);
    const op = pick(ops);
    const revisionId = pick(revisions);
    if (op === 'save') {
      const r = await invoker.run(useCases.updateItem, admin, {
        itemId,
        baseRevisionId: revisions.at(-1)!,
        document: document(step),
      });
      revisions.push(r.revision.id);
    } else if (op === 'publish') {
      await invoker.run(useCases.publishItem, admin, { itemId, revisionId, locale });
      expected.set(locale, revisionId);
      plans.set(locale, null);
    } else if (op === 'unpublish') {
      await invoker.run(useCases.unpublishItem, admin, { itemId, locale });
      expected.set(locale, null);
      plans.set(locale, null);
    } else if (op === 'schedule') {
      const at = clock.now().getTime() + Math.floor(rnd() * 3 + 1) * 60_000;
      await invoker.run(useCases.scheduleItem, admin, {
        itemId,
        revisionId,
        locale,
        at: new Date(at).toISOString(),
      });
      plans.set(locale, { revisionId, at });
    } else if (op === 'unschedule') {
      await invoker.run(useCases.unscheduleItem, admin, { itemId, locale });
      plans.set(locale, null);
    } else {
      // Time passes and every open job runs once, in a random order, some of them twice.
      clock.advance(60_000);
      const open = uow.store.jobs.filter((j) => j.doneAt === null).sort(() => rnd() - 0.5);
      for (const job of open) {
        const payload = parseJobPayload('content.publish', job.payload);
        const times = rnd() < 0.2 ? 2 : 1;
        for (let i = 0; i < times; i++) {
          const outcome = await uow.run(systemPrincipal(TENANT, 'jobs'), (ctx) =>
            publishScheduled(ctx, payload)
          );
          if (i === 0) {
            job.doneAt = clock.now();
            if (outcome.next)
              uow.store.jobs.push({ ...job, id: `${job.id}+`, runAt: outcome.next, doneAt: null });
          }
        }
      }
      for (const l of LOCALES) {
        const plan = plans.get(l);
        if (plan && plan.at <= clock.now().getTime()) {
          expected.set(l, plan.revisionId);
          plans.set(l, null);
        }
      }
    }

    const { item } = await invoker.run(useCases.getItem, admin, { itemId });
    for (const s of item.publication) {
      const context = `seed ${seed}, step ${step} (${op} ${locale}), locale ${s.locale}`;
      // The live revision is exactly what the operations put there; nothing else moves it.
      expect(s.publishedRevisionId, context).toBe(expected.get(s.locale));
      expect(s.scheduledRevisionId, context).toBe(plans.get(s.locale)?.revisionId ?? null);
      // A pin always has a time and an id; the status follows the pointers.
      expect(s.scheduleId === null, context).toBe(s.scheduledFor === null);
      if (s.publishedRevisionId) expect(s.status, context).toBe('published');
      else if (s.scheduledRevisionId) expect(s.status, context).toBe('scheduled');
      else expect(['draft', 'unpublished'], context).toContain(s.status);
      if (s.publishedRevisionId) expect(revisions, context).toContain(s.publishedRevisionId);
    }
    expect(item.latestRevisionId).toBe(revisions.at(-1));
  }
}

describe('publication lifecycle properties', () => {
  it.each(Array.from({ length: 25 }, (_, i) => 1000 + i))(
    'seed %i keeps the invariants for 60 random steps',
    async (seed) => runSequence(seed, 60)
  );
});
