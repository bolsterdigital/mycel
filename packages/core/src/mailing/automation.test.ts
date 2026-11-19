// Welcome series (ADR 010 rule 10, MY-258), in memory: who starts a series, when each step is
// due, what stops or skips a step, and what reaches the provider. The provider is the outside
// world: `MemoryMailer` records what it accepted. The tables' RLS is in packages/db.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS, type TenantAccess } from '../entitlements/model.js';
import { Invoker } from '../invoke.js';
import type { Subscriber } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import { ingest, supporterIngestSubscriber } from '../supporters/service.js';
import { SupporterEvent } from '../supporters/events.js';
import {
  expectCode,
  FakeClock,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  pageDocument,
  principal,
  probeTenant,
  TENANT,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import {
  AUTOMATION_DUE,
  automationMailSubscriber,
  automationSubscriber,
  runAutomationStep,
} from './automation.js';
import type { EditionMailDeps } from './edition-delivery.js';
import { UNSUBSCRIBE_PLACEHOLDER } from './email.js';
import { ONE_CLICK_VALUE } from './unsubscribe.js';

const LIST = 'newsletter';
const DAY = 24 * 60 * 60 * 1000;

describe('mailing.automation', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  let mailer: MemoryMailer;
  let access: TenantAccess;
  let deps: EditionMailDeps;
  let subscribers: Subscriber[];
  let welcome: string;
  let tips: string;
  let n = 0;

  const admin = systemPrincipal(TENANT, 'test');
  const page = async (slug: string, title: string, over: Record<string, unknown> = {}) => {
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug,
      document: { ...pageDocument({ title: { nl: title, en: `${title} (en)` } }), ...over },
    });
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, admin, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
    return item.id;
  };
  const setSeries = (enabled = true, steps = [0, 2], list = LIST) =>
    invoker.run(useCases.updateAutomation, admin, {
      list,
      enabled,
      steps: steps.map((delayDays, i) => ({ itemId: i ? tips : welcome, delayDays })),
    });
  /** A joining event as the outbox carries it, handed to the subscribers in order. */
  const join = async (
    email: string,
    props: Record<string, unknown> = {},
    type = 'consent.given',
    to = subscribers
  ) => {
    n++;
    const event = {
      id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
      type,
      tenantId: TENANT,
      occurredAt: clock.now(),
      actor: admin.actor,
      props: {
        list: LIST,
        locale: 'nl',
        email,
        submissionId: `00000000-0000-7000-8001-${String(n).padStart(12, '0')}`,
        formId: '00000000-0000-7000-8002-000000000001',
        consentTextVersion: 'v1',
        ...props,
      },
    };
    for (const sub of to) if (sub.types.includes(type)) await sub.handle(event);
  };
  const leave = (email: string) =>
    uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `leave-${++n}`,
          type: 'newsletter.unsubscribed',
          email,
          occurred_at: clock.now().toISOString(),
          source: 'test',
          source_site: 'urn:test',
          source_ref: `test:${n}`,
          props: { list: LIST },
        })
      )
    );
  const stepJobs = () =>
    uow.store.jobs.filter((j) => j.type === 'mailing.automation.step' && !j.doneAt);
  /** Run every step job that is due now, then deliver what they published. */
  const tick = async () => {
    for (const job of stepJobs().filter((j) => j.runAt <= clock.now())) {
      job.doneAt = clock.now();
      await runAutomationStep(deps, TENANT, job.payload as never);
    }
    await uow.drain(subscribers);
  };
  const subjects = () => mailer.sent.map((m) => `${m.to.email} ${m.subject}`);

  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    mailer = new MemoryMailer();
    access = DEFAULT_ACCESS;
    deps = {
      mailer,
      signer: uow.signer,
      clock,
      tenants: new MemoryTenants([probeTenant(TENANT)]),
      uow,
      from: { email: 'noreply@example.org' },
      platform: uow.platform,
      access: async () => access,
    };
    subscribers = [
      supporterIngestSubscriber(uow),
      automationSubscriber(deps),
      automationMailSubscriber(deps),
    ];
    welcome = await page('welkom', 'Welkom');
    tips = await page('dit-kun-je-doen', 'Dit kun je doen');
    uow.store.outbox.splice(0);
  });

  it('sends step 0 at once and step 1 on its day, each once, with an unsubscribe link', async () => {
    await setSeries();
    await join('ada@example.org');
    await tick();
    expect(subjects()).toEqual(['ada@example.org Welkom']);
    const first = mailer.sent[0]!;
    expect(first.stream).toBe('bulk');
    expect(first.headers?.['List-Unsubscribe-Post']).toBe(ONE_CLICK_VALUE);
    expect(first.html).not.toContain(UNSUBSCRIBE_PLACEHOLDER);
    // The due event names ids only.
    expect(uow.store.outbox).toEqual([]);

    clock.advance(DAY);
    await tick();
    expect(mailer.sent).toHaveLength(1);
    clock.advance(DAY);
    await tick();
    await tick();
    expect(subjects()).toEqual(['ada@example.org Welkom', 'ada@example.org Dit kun je doen']);
    expect(stepJobs()).toEqual([]);

    const { automations } = await invoker.run(useCases.listAutomations, admin, {});
    expect(automations[0]).toMatchObject({ started: 1, steps: [{ reached: 1 }, { reached: 1 }] });
  });

  it('starts nothing for a pending signup, another list, a switched-off series or before it existed', async () => {
    await join('early@example.org');
    await setSeries(false);
    await join('off@example.org');
    await setSeries();
    await join('pending@example.org', { confirmed: false }, 'newsletter.subscribed');
    await join('other@example.org', { list: 'campaign-news' });
    await tick();
    expect(mailer.sent).toEqual([]);
    expect(stepJobs()).toEqual([]);
  });

  it('starts once: leaving and joining again does not start the series over', async () => {
    await setSeries(true, [0]);
    await join('ada@example.org');
    await tick();
    await leave('ada@example.org');
    await join('ada@example.org');
    await tick();
    expect(subjects()).toEqual(['ada@example.org Welkom']);
  });

  it('stops for someone who left the list or when the series is switched off', async () => {
    await setSeries();
    await join('ada@example.org');
    await join('bob@example.org');
    await tick();
    await leave('ada@example.org');
    clock.advance(2 * DAY);
    await tick();
    expect(subjects().filter((s) => s.includes('Dit kun je doen'))).toEqual([
      'bob@example.org Dit kun je doen',
    ]);

    await join('cy@example.org');
    await tick();
    await setSeries(false);
    clock.advance(2 * DAY);
    await tick();
    expect(subjects().filter((s) => s.startsWith('cy'))).toEqual(['cy@example.org Welkom']);
  });

  it('skips a step whose item may no longer be mailed, and goes on with the next', async () => {
    await setSeries();
    await join('ada@example.org');
    // Unpublished in both locales before the first step ran.
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.unpublishItem, admin, { itemId: welcome, locale });
    await tick();
    expect(mailer.sent).toEqual([]);
    clock.advance(2 * DAY);
    await tick();
    expect(subjects()).toEqual(['ada@example.org Dit kun je doen']);
  });

  it('runs a step job twice without a second mail', async () => {
    await setSeries(true, [0]);
    await join('ada@example.org');
    const [job] = stepJobs();
    await runAutomationStep(deps, TENANT, job!.payload as never);
    await runAutomationStep(deps, TENANT, job!.payload as never);
    expect(uow.store.outbox.filter((e) => e.type === AUTOMATION_DUE)).toHaveLength(1);
    expect(JSON.stringify(uow.store.outbox[0]!.props)).not.toContain('@');
    await uow.drain(subscribers);
    expect(mailer.sent).toHaveLength(1);
  });

  it('starts the series when it runs before the supporter ingest, or without it', async () => {
    await setSeries(true, [0]);
    const [ingestSub, start, mail] = subscribers;
    await join('first@example.org', {}, 'consent.given', [start!, ingestSub!, mail!]);
    await join('alone@example.org', {}, 'consent.given', [start!, mail!]);
    await tick();
    expect(subjects().sort()).toEqual(['alone@example.org Welkom', 'first@example.org Welkom']);
  });

  it('mails the locale someone joined in, else the default', async () => {
    await setSeries(true, [0]);
    await join('en@example.org', { locale: 'en' });
    await join('fr@example.org', { locale: 'fr' });
    await tick();
    expect(subjects().sort()).toEqual(['en@example.org Welkom (en)', 'fr@example.org Welkom']);
  });

  it('sends nothing for a suspended tenant and looks again a day later', async () => {
    await setSeries(true, [0]);
    await join('ada@example.org');
    access = { ...DEFAULT_ACCESS, status: 'suspended' };
    const [job] = stepJobs();
    const out = await runAutomationStep(deps, TENANT, job!.payload as never);
    expect(out.next?.getTime()).toBe(clock.now().getTime() + DAY);
    expect(uow.store.outbox).toEqual([]);
  });

  it('refuses an unknown, unpublished or restricted item and two steps on one day', async () => {
    const draft = (
      await invoker.run(useCases.createItem, admin, {
        slug: 'concept',
        document: pageDocument({ title: { nl: 'Concept' } }),
      })
    ).item.id;
    const closed = await page('besloten', 'Besloten', {
      access: { level: 'members', teaser: 'lead' },
      lead: { nl: 'Alleen voor leden.', en: 'Members only.' },
    });
    const update = (itemId: string, delays = [0]) =>
      invoker.run(useCases.updateAutomation, admin, {
        list: LIST,
        enabled: true,
        steps: delays.map((delayDays) => ({ itemId, delayDays })),
      });
    await expectCode(update('00000000-0000-7000-8000-00000000ffff'), 'conflict');
    await expectCode(update(draft), 'conflict');
    await expectCode(update(closed), 'conflict');
    await expectCode(update(welcome, [1, 1]), 'conflict');
  });

  it('keeps one series per list and its steps in order of delay', async () => {
    const first = await setSeries(true, [3, 0]);
    expect(first.steps.map((s) => [s.delayDays, s.itemId])).toEqual([
      [0, tips],
      [3, welcome],
    ]);
    const again = await setSeries(false, [0]);
    expect(again.id).toBe(first.id);
    expect((await invoker.run(useCases.listAutomations, admin, {})).automations).toHaveLength(1);
  });

  it('lets only mailing:send change a series, and supporters:read see it', async () => {
    const editor = principal({
      capabilities: ['content:read', 'content:write', 'supporters:read'],
    });
    await expectCode(
      invoker.run(useCases.updateAutomation, editor, {
        list: LIST,
        enabled: true,
        steps: [{ itemId: welcome, delayDays: 0 }],
      }),
      'forbidden'
    );
    await invoker.run(useCases.listAutomations, editor, {});
  });
});
