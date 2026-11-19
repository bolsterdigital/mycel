// Welcome series, the first automation (ADR 010 rule 10, MY-258). A series belongs to one list
// and holds one to five steps, each an item of the site (a page or an article) sent so many days
// after a person joined the list. The trigger is the moment of joining: a confirmed
// `newsletter.subscribed` or a `consent.given` for that list, read from the outbox. A pending
// double opt-in starts nothing, and nobody who joined before the series was switched on gets it.
//
// The chain has three links, each in its own transaction:
// 1. The subscriber `mailing.automation` starts a run (one row per series and person: once is
//    once, so leaving and joining again does not start it over) and plans the job of step 0.
// 2. The job `mailing.automation.step` checks the stop conditions, marks the position handled and
//    publishes `mailing.automation.due` (ids only) in one transaction, then plans the next step.
//    A job that runs twice finds the position handled and publishes nothing a second time.
// 3. The subscriber `mailing.automation.mail` renders the item and sends it through `sendOnce`,
//    so `mail.reconcile` can rebuild the message from that event like any other mail.
//
// A step is skipped, not sent, when its item is gone, not published in a locale the person can
// read, or restricted (ADR 016: restricted content is not mailed); a skipped step does not stop
// the next. The series stops for a person who left the list, was erased, or when it is switched
// off: switching it on again later does not resume runs that were stopped.
//
// The item is rendered when its step is due, from the revision published then: a correction of
// the page reaches whoever gets the step afterwards. That is how an automation behaves, unlike an
// edition (ADR 018 rule 4), which is one send to many and kept as it went out.
//
// Rejected: a mail template entity beside pages and articles (a second content model and a second
// editor, against ADR 010 rule 6), sending an unpublished draft (a half-edited draft would go out
// at once), sending from the job itself under a key without an outbox event (`mail.reconcile`
// reads the event; the joining event is pruned by retention long before a sixty-day step), and a
// bulk throughput count for these mails (one per confirmation; the edition limit is for lists).

import { z } from 'zod';
import { entitled, requireEntitled } from '../entitlements/guards.js';
import { UseCaseError } from '../errors.js';
import { jobKey } from '../jobs/types.js';
import type { JobOutcome } from '../jobs/ports.js';
import type { DomainEvent, Subscriber, TransactionContext } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import { defineUseCase } from '../registry.js';
import { exampleId } from '../util/ids.js';
import { statusOf } from '../content/lifecycle.js';
import type { ItemRecord } from '../content/ports.js';
import { isTombstone } from '../supporters/erasure.js';
import { ingest, toSupporterEvent } from '../supporters/service.js';
import { siteUrl } from '../tenants/url.js';
import type { ConfirmationMailDeps } from './confirmation.js';
import { signupLocale, type EditionMailDeps } from './edition-delivery.js';
import { emailDocument, UNSUBSCRIBE_PLACEHOLDER, withUnsubscribeUrl } from './email.js';
import type { MailAutomation, MailMessage } from './ports.js';
import { sendOnce, type MailSource } from './send-attempts.js';
import { unsubscribeLink } from './unsubscribe.js';
import '../content/ports.js';
import '../jobs/ports.js';
import '../supporters/ports.js';
import './ports.js';

/** Starts a run when someone joins a list that has a series switched on. */
export const AUTOMATION_SUBSCRIBER = 'mailing.automation';
/** Sends the mail of one due step; the intent key is this name and the due event's id. */
export const AUTOMATION_MAIL_SUBSCRIBER = 'mailing.automation.mail';
/** A step is due for one person: ids only, never an address. */
export const AUTOMATION_DUE = 'mailing.automation.due';
export interface AutomationDueProps {
  automationId: string;
  supporterId: string;
  position: number;
  itemId: string;
  locale: string;
}

export const MAX_AUTOMATION_STEPS = 5;
export const MAX_AUTOMATION_DELAY_DAYS = 60;
const DAY = 24 * 60 * 60 * 1000;

const ListName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const Step = z
  .object({
    itemId: z.string().guid(),
    delayDays: z.number().int().min(0).max(MAX_AUTOMATION_DELAY_DAYS),
  })
  .strict();

const AutomationOut = z.object({
  id: z.string().guid(),
  list: z.string(),
  enabled: z.boolean(),
  steps: z.array(
    z.object({
      itemId: z.string().guid(),
      delayDays: z.number().int(),
      /** How many people got as far as this step (sent or skipped). */
      reached: z.number().int().nonnegative(),
    })
  ),
  /** How many people started the series. */
  started: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

const refuse = (issue: string, message: string, params?: Record<string, string>) =>
  new UseCaseError('conflict', message, [
    { path: '', message: issue, ...(params ? { params } : {}) },
  ]);

/** The published, public revision of `item` in `locale`, or null when it may not be mailed. */
async function mailable(ctx: TransactionContext, item: ItemRecord, locale: string) {
  const state = item.publication.find((s) => s.locale === locale);
  if (!state || statusOf(state) !== 'published' || !state.publishedRevisionId) return null;
  const revision = await ctx.content.revision(item.id, state.publishedRevisionId);
  if (!revision || revision.document.access.level !== 'public') return null;
  return revision;
}

/** The locale a person gets: the one they joined in when the item has it, else the default. */
async function stepLocale(
  ctx: TransactionContext,
  item: ItemRecord,
  joined: string | null,
  defaultLocale: string
): Promise<string | null> {
  for (const locale of [joined, defaultLocale])
    if (locale && (await mailable(ctx, item, locale))) return locale;
  return null;
}

async function view(ctx: TransactionContext, a: MailAutomation) {
  const { started, reached } = await ctx.mailAutomations.reach(a.id);
  return {
    id: a.id,
    list: a.list,
    enabled: a.enabled,
    steps: a.steps.map((s, i) => ({ ...s, reached: reached[i] ?? 0 })),
    started,
    updatedAt: a.updatedAt.toISOString(),
  };
}

export const listAutomations = defineUseCase({
  name: 'mailing.automation.list',
  kind: 'query',
  description:
    'List the welcome series of the site, one per list: whether it is on, its steps (an item sent so many days after joining) and how many people started it and reached each step. No addresses.',
  requires: 'supporters:read',
  input: z.object({}).strict(),
  output: z.object({ automations: z.array(AutomationOut) }),
  examples: [{ input: {} }],
  async handler(ctx) {
    const all = await ctx.mailAutomations.list();
    const automations = [];
    for (const a of all) automations.push(await view(ctx, a));
    return { automations };
  },
});

export const updateAutomation = defineUseCase({
  name: 'mailing.automation.update',
  kind: 'command',
  description:
    'Set the welcome series of a list: its steps (one to five, each a published public page or article sent so many days, 0 to 60, after a person joins the list) and whether it is on. Only people who confirm their subscription while it is on get it, each step once; leaving the list stops it. Steps are kept in order of delay. Refuses an unknown, unpublished or restricted item and two steps on the same day. Creates the series when the list has none.',
  requires: 'mailing:send',
  input: z
    .object({
      list: ListName,
      enabled: z.boolean(),
      steps: z.array(Step).min(1).max(MAX_AUTOMATION_STEPS),
    })
    .strict(),
  output: AutomationOut,
  examples: [
    {
      input: {
        list: 'newsletter',
        enabled: true,
        steps: [
          { itemId: exampleId(0x1), delayDays: 0 },
          { itemId: exampleId(0x2), delayDays: 3 },
        ],
      },
    },
  ],
  async handler(ctx, { list, enabled, steps }) {
    requireEntitled(ctx.principal, 'mailing.enabled');
    const ordered = [...steps].sort((a, b) => a.delayDays - b.delayDays);
    for (let i = 1; i < ordered.length; i++)
      if (ordered[i]!.delayDays === ordered[i - 1]!.delayDays)
        throw refuse('mailing.automation.same-day', 'two steps on the same day', {
          days: String(ordered[i]!.delayDays),
        });
    for (const step of ordered) {
      const item = await ctx.content.get(step.itemId);
      if (!item) throw refuse('mailing.automation.no-item', 'unknown item', { id: step.itemId });
      let published = false;
      for (const s of item.publication) if (await mailable(ctx, item, s.locale)) published = true;
      if (!published)
        throw refuse(
          'mailing.automation.not-mailable',
          'the item is not published as public content in any locale',
          { id: step.itemId }
        );
    }
    const now = ctx.clock.now();
    const existing = await ctx.mailAutomations.forList(list);
    const automation: MailAutomation = {
      id: existing?.id ?? ctx.ids.next(),
      list,
      enabled,
      steps: ordered,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await ctx.mailAutomations.save(automation);
    return view(ctx, automation);
  },
});

/** When step `position` of a run that started at `startedAt` is due; never before `now`. */
const dueAt = (startedAt: Date, delayDays: number, now: Date): Date =>
  new Date(Math.max(startedAt.getTime() + delayDays * DAY, now.getTime()));

async function planStep(
  ctx: TransactionContext,
  automation: MailAutomation,
  supporterId: string,
  position: number,
  startedAt: Date
): Promise<void> {
  const step = automation.steps[position];
  if (!step) return;
  await ctx.jobs.enqueue({
    type: 'mailing.automation.step',
    key: jobKey('mailing.automation.step', `${automation.id}:${supporterId}:${position}`),
    runAt: dueAt(startedAt, step.delayDays, ctx.clock.now()),
    payload: { automationId: automation.id, supporterId, position },
  });
}

/** The list a joining event confirms, or null for a pending signup and any other event. */
function joinedList(event: DomainEvent): string | null {
  const list = event.props['list'];
  if (typeof list !== 'string') return null;
  if (event.type === 'consent.given') return list;
  if (event.type === 'newsletter.subscribed' && event.props['confirmed'] !== false) return list;
  return null;
}

/**
 * Starts a run for whoever joins a list with a series switched on. It ingests the joining event
 * itself first, as `supporters.ingest` does from the same event (idempotent: a second append
 * of one event changes nothing), so the membership it reads never lags the event that caused it,
 * whichever subscriber the outbox runs first and even when that one failed.
 */
export function automationSubscriber(deps: Pick<EditionMailDeps, 'uow' | 'access'>): Subscriber {
  return {
    name: AUTOMATION_SUBSCRIBER,
    types: ['newsletter.subscribed', 'consent.given'],
    async handle(event) {
      const list = joinedList(event);
      const email = event.props['email'];
      if (!list || typeof email !== 'string') return;
      const access = await deps.access(event.tenantId);
      const principal = systemPrincipal(event.tenantId, AUTOMATION_SUBSCRIBER, access);
      if (access.status === 'suspended' || !entitled(principal, 'mailing.enabled')) return;
      await deps.uow.run(principal, async (ctx) => {
        const automation = await ctx.mailAutomations.forList(list);
        if (!automation?.enabled || !automation.steps.length) return;
        await ingest(ctx, await toSupporterEvent(event));
        const supporter = await ctx.supporters.getProjection(email);
        if (!supporter?.lists.includes(list)) return;
        if (!(await ctx.mailAutomations.start(automation.id, supporter.id, event.occurredAt)))
          return;
        await planStep(ctx, automation, supporter.id, 0, event.occurredAt);
      });
    },
  };
}

/**
 * One run of `mailing.automation.step`: hand the step to the mail subscriber when it may go,
 * mark it handled, plan the next. A suspended tenant, or one without mailing, is looked at again
 * in a day (ADR 015 rule 7).
 */
export async function runAutomationStep(
  deps: Pick<EditionMailDeps, 'uow' | 'access' | 'clock' | 'tenants'>,
  tenantId: string,
  job: { automationId: string; supporterId: string; position: number }
): Promise<JobOutcome> {
  const access = await deps.access(tenantId);
  const principal = systemPrincipal(tenantId, AUTOMATION_SUBSCRIBER, access);
  if (access.status === 'suspended' || !entitled(principal, 'mailing.enabled'))
    return { next: new Date(deps.clock.now().getTime() + DAY) };
  const tenant = await deps.tenants.findById(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  const { automationId, supporterId, position } = job;
  await deps.uow.run(principal, async (ctx) => {
    const automation = await ctx.mailAutomations.get(automationId);
    const run = await ctx.mailAutomations.run(automationId, supporterId);
    if (!automation?.enabled || !run || run.through >= position) return;
    const step = automation.steps[position];
    if (!step) return;
    const supporter = await ctx.supporters.getProjectionById(supporterId);
    if (!supporter || isTombstone(supporter.email) || !supporter.lists.includes(automation.list))
      return;
    if (!(await ctx.mailAutomations.advance(automationId, supporterId, position))) return;
    const item = await ctx.content.get(step.itemId);
    const joined = signupLocale(await ctx.supporters.eventsFor(supporterId), automation.list);
    const locale = item && (await stepLocale(ctx, item, joined, tenant.defaultLocale));
    if (item && locale) {
      const props: AutomationDueProps = {
        automationId,
        supporterId,
        position,
        itemId: item.id,
        locale,
      };
      await ctx.events.publish({
        id: ctx.ids.next(),
        type: AUTOMATION_DUE,
        tenantId,
        occurredAt: ctx.clock.now(),
        actor: principal.actor,
        props: { ...props },
      });
    }
    await planStep(ctx, automation, supporterId, position + 1, run.startedAt);
  });
  return {};
}

/**
 * The mail of one due step, built when it is sent and again by `mail.reconcile`: null when the
 * person left the list, the series was switched off or the item may no longer be mailed.
 */
export function automationMailSource(
  deps: ConfirmationMailDeps & Pick<EditionMailDeps, 'access'>
): MailSource {
  return async (event) => {
    if (event.type !== AUTOMATION_DUE) return null;
    const p = event.props as unknown as AutomationDueProps;
    const access = await deps.access(event.tenantId);
    const principal = systemPrincipal(event.tenantId, AUTOMATION_MAIL_SUBSCRIBER, access);
    if (access.status === 'suspended' || !entitled(principal, 'mailing.enabled')) return null;
    const tenant = await deps.tenants.findById(event.tenantId);
    if (!tenant) throw new Error(`tenant ${event.tenantId} not found`);
    const found = await deps.uow.run(principal, async (ctx) => {
      const automation = await ctx.mailAutomations.get(p.automationId);
      const supporter = await ctx.supporters.getProjectionById(p.supporterId);
      const item = await ctx.content.get(p.itemId);
      if (!automation?.enabled || !supporter || !item) return null;
      if (isTombstone(supporter.email) || !supporter.lists.includes(automation.list)) return null;
      const revision = await mailable(ctx, item, p.locale);
      if (!revision) return null;
      const primaryHostname = (await ctx.hostnames.primary())?.hostname ?? null;
      const site = {
        name: tenant.name,
        url: siteUrl({ slug: tenant.slug, primaryHostname }, deps.platform, ''),
        defaultLocale: tenant.defaultLocale,
      };
      const email = await emailDocument(ctx, {
        item,
        doc: revision.document,
        locale: p.locale,
        site,
        unsubscribe: UNSUBSCRIBE_PLACEHOLDER,
      });
      return {
        list: automation.list,
        supporter,
        primaryHostname,
        subject: email.subject,
        rendered: ctx.emailRenderer.render(email),
      };
    });
    if (!found?.subject) return null;
    const link = await unsubscribeLink(deps, {
      tenant,
      primaryHostname: found.primaryHostname,
      supporterId: found.supporter.id,
      list: found.list,
      locale: p.locale,
    });
    const message: MailMessage = {
      from: { email: deps.from.email, name: tenant.name },
      to: { email: found.supporter.email },
      subject: found.subject,
      ...withUnsubscribeUrl(found.rendered, link.url),
      headers: link.headers,
      stream: 'bulk',
    };
    return message;
  };
}

/** Sends a due step after commit, from the outbox, once per event (`sendOnce`). */
export function automationMailSubscriber(
  deps: ConfirmationMailDeps & Pick<EditionMailDeps, 'access'>
): Subscriber {
  const source = automationMailSource(deps);
  return {
    name: AUTOMATION_MAIL_SUBSCRIBER,
    types: [AUTOMATION_DUE],
    async handle(event) {
      const message = await source(event);
      if (!message) return;
      const { supporterId } = event.props as unknown as AutomationDueProps;
      await sendOnce(
        deps,
        // The supporter's own id is its lifecycle evidence (ADR 032), as for an edition.
        {
          id: event.id,
          tenantId: event.tenantId,
          props: { email: message.to.email, supporterLifecycleId: supporterId },
        },
        AUTOMATION_MAIL_SUBSCRIBER,
        message
      );
    },
  };
}
