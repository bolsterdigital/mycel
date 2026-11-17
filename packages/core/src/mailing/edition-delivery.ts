// Delivery of an edition (ADR 010 rules 8 and 9, ADR 011 rule 3, ADR 019 rules 5 and 6). One
// tenant job per edition walks the list's confirmed members in id order and hands each to
// `sendOnce` under the intent key `mailing.edition:<supporter>:<edition>`: a job that runs twice,
// or two workers on one job, find the intent and send nothing a second time. The job starts at
// most the tenant's `mail.bulk_per_minute` attempts per minute, counted over every edition of the
// tenant, and plans itself again a minute later until the list is done.
//
// Bulk never waits in front of transactional mail (rule 9): the outbox carries one event per
// edition, not one per recipient, and the job runs in a pool of its own, so a confirmation or a
// sign-in link passes a newsletter of any size.
//
// Members are read from the projection at the start of each run, so someone who unsubscribed
// or was erased before their turn gets nothing; the claim itself checks the erasure register
// again. Each message carries the recipient's own unsubscribe link and the RFC 8058 headers
// (unsubscribe.ts). The address is never stored: `mail.reconcile` rebuilds a message from the
// edition and the supporter id in the intent's key.
//
// A recipient gets the locale they signed up in when the edition has it, else the site's default
// locale, else the edition's first. The signup locale is read from the supporter's own log.
//
// Rejected: one outbox event per recipient (a big list would queue in front of every other
// event, and the throughput limit would have to fail events to slow them), a recipients table
// (a second record of who was sent what), and a cursor in the job payload (a job's payload is
// fixed when it is planned).

import { entitled, limitOf } from '../entitlements/guards.js';
import type { TenantAccess } from '../entitlements/model.js';
import { UseCaseError } from '../errors.js';
import type { JobOutcome } from '../jobs/ports.js';
import type { Subscriber } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import { isTombstone } from '../supporters/erasure.js';
import type { SupporterEvent } from '../supporters/events.js';
import type { SupporterProjection } from '../supporters/model.js';
import type { TenantInfo } from '../tenants/ports.js';
import type { ConfirmationMailDeps } from './confirmation.js';
import {
  EDITION_TEST_REQUESTED,
  editionForViewing,
  editionLocale,
  testSubject,
  type EditionTestProps,
} from './edition.js';
import { withUnsubscribeUrl } from './email.js';
import type { MailEdition, MailEditionLocale, MailMessage } from './ports.js';
import { recipientIntentKey, sendOnce, type MailSource } from './send-attempts.js';
import { unsubscribeLink } from './unsubscribe.js';

export const EDITION_SUBSCRIBER = 'mailing.edition';
export const EDITION_TEST_SUBSCRIBER = 'mailing.edition.test';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
/**
 * How long one run keeps sending. Under the job's five-minute lease with room for the last
 * provider call, so a slow provider ends the run instead of letting a second worker start it.
 */
export const EDITION_RUN_BUDGET_MS = 3 * MINUTE;

export interface EditionMailDeps extends ConfirmationMailDeps {
  access: (tenantId: string) => Promise<TenantAccess>;
}

/** The locale of the supporter's latest signup for `list`, from their own log. */
export function signupLocale(events: readonly SupporterEvent[], list: string): string | null {
  let latest: SupporterEvent | null = null;
  for (const e of events) {
    if (e.type !== 'newsletter.subscribed' && e.type !== 'consent.given') continue;
    if (e.props['list'] !== list || typeof e.props['locale'] !== 'string') continue;
    if (!latest || Date.parse(e.occurred_at) >= Date.parse(latest.occurred_at)) latest = e;
  }
  return latest ? (latest.props['locale'] as string) : null;
}

/** The locale of an edition a recipient gets: their own, else the default, else the first. */
export function editionLocaleFor(
  edition: Pick<MailEdition, 'locales'>,
  signup: string | null,
  defaultLocale: string
): MailEditionLocale {
  return (
    edition.locales.find((l) => l.locale === signup) ??
    edition.locales.find((l) => l.locale === defaultLocale) ??
    edition.locales[0]!
  );
}

async function recipientMessage(
  deps: EditionMailDeps,
  site: { tenant: TenantInfo; primaryHostname: string | null },
  edition: MailEdition,
  recipient: { supporter: SupporterProjection; signup: string | null }
): Promise<MailMessage> {
  const { tenant } = site;
  const mail = editionLocaleFor(edition, recipient.signup, tenant.defaultLocale);
  const link = await unsubscribeLink(deps, {
    tenant,
    primaryHostname: site.primaryHostname,
    supporterId: recipient.supporter.id,
    list: edition.list,
    locale: mail.locale,
  });
  return {
    from: { email: deps.from.email, name: tenant.name },
    to: { email: recipient.supporter.email },
    subject: mail.subject,
    ...withUnsubscribeUrl(mail, link.url),
    headers: link.headers,
    stream: 'bulk',
  };
}

const tenantOf = async (deps: EditionMailDeps, tenantId: string): Promise<TenantInfo> => {
  const tenant = await deps.tenants.findById(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  return tenant;
};

/**
 * The message of one recipient of an edition, rebuilt for `mail.reconcile` from the event (its
 * id is the edition's) and the supporter id in the intent's key; null when that person is no
 * longer a confirmed member, so an unsubscribe ends a retry too.
 */
export function editionMailSource(deps: EditionMailDeps): MailSource {
  return async (event, key) => {
    const prefix = `${EDITION_SUBSCRIBER}:`;
    const suffix = `:${event.id}`;
    if (!key?.startsWith(prefix) || !key.endsWith(suffix)) return null;
    const supporterId = key.slice(prefix.length, key.length - suffix.length);
    const access = await deps.access(event.tenantId);
    const principal = systemPrincipal(event.tenantId, EDITION_SUBSCRIBER, access);
    if (access.status === 'suspended' || !entitled(principal, 'mailing.enabled')) return null;
    const found = await deps.uow.run(principal, async (ctx) => {
      const edition = await ctx.mailEditions.get(event.id);
      const supporter = await ctx.supporters.getProjectionById(supporterId);
      if (!edition || !supporter || isTombstone(supporter.email)) return null;
      if (!supporter.lists.includes(edition.list)) return null;
      return {
        edition,
        supporter,
        signup: signupLocale(await ctx.supporters.eventsFor(supporter.id), edition.list),
        primaryHostname: (await ctx.hostnames.primary())?.hostname ?? null,
      };
    });
    if (!found) return null;
    const tenant = await tenantOf(deps, event.tenantId);
    return recipientMessage(deps, { tenant, ...found }, found.edition, found);
  };
}

/**
 * One run of `mailing.edition.deliver`: the next members of the list, as many as the tenant's
 * throughput still allows this minute, each through `sendOnce`. Returns `{}` when the list is
 * done (or the edition is gone), `{ next }` otherwise. A suspended tenant, or one without
 * mailing, sends nothing and is looked at again in a day (ADR 015 rule 7).
 */
export async function deliverEdition(
  deps: EditionMailDeps,
  tenantId: string,
  editionId: string
): Promise<JobOutcome> {
  const access = await deps.access(tenantId);
  const principal = systemPrincipal(tenantId, EDITION_SUBSCRIBER, access);
  const started = deps.clock.now();
  const later = (ms: number) => ({ next: new Date(deps.clock.now().getTime() + ms) });
  const perMinute = limitOf(principal, 'mail.bulk_per_minute');
  if (access.status === 'suspended' || !entitled(principal, 'mailing.enabled') || perMinute < 1)
    return later(DAY);

  const batch = await deps.uow.run(principal, async (ctx) => {
    const edition = await ctx.mailEditions.get(editionId);
    if (!edition || edition.completedAt) return null;
    const recent = await ctx.mailSends.attemptedSince(
      EDITION_SUBSCRIBER,
      new Date(started.getTime() - MINUTE)
    );
    const room = Math.max(0, perMinute - recent);
    const members = room
      ? await ctx.supporters.members(edition.list, { after: edition.deliveredThrough, limit: room })
      : [];
    const recipients = [];
    for (const supporter of members)
      recipients.push({
        supporter,
        signup: signupLocale(await ctx.supporters.eventsFor(supporter.id), edition.list),
      });
    return {
      edition,
      room,
      recipients,
      primaryHostname: (await ctx.hostnames.primary())?.hostname ?? null,
    };
  });
  if (!batch) return {};
  // Another edition of this tenant used the minute: look again when it has passed.
  if (batch.room === 0) return later(MINUTE);

  const tenant = await tenantOf(deps, tenantId);
  let last: string | null = null;
  let cut = false;
  for (const recipient of batch.recipients) {
    if (deps.clock.now().getTime() - started.getTime() > EDITION_RUN_BUDGET_MS) {
      cut = true;
      break;
    }
    const { supporter } = recipient;
    const message = await recipientMessage(deps, { tenant, ...batch }, batch.edition, recipient);
    await sendOnce(
      deps,
      // The supporter's own id is its lifecycle evidence (ADR 032), as for an unsubscribe.
      {
        id: editionId,
        tenantId,
        props: { email: supporter.email, supporterLifecycleId: supporter.id },
      },
      EDITION_SUBSCRIBER,
      message,
      recipientIntentKey(EDITION_SUBSCRIBER, supporter.id, editionId)
    );
    last = supporter.id;
  }
  const done = !cut && batch.recipients.length < batch.room;
  await deps.uow.run(principal, async (ctx) => {
    if (last) await ctx.mailEditions.advance(editionId, last);
    if (done) await ctx.mailEditions.complete(editionId, deps.clock.now());
  });
  return done ? {} : later(MINUTE);
}

/**
 * The test mail of `mailing.edition.test`: the published locale rendered when it is sent, to the
 * member row's address of the operator who asked. No message when that member is gone or the
 * locale may no longer be mailed. Transactional stream: one message someone asked for.
 */
export function editionTestMailSource(deps: EditionMailDeps): MailSource {
  return async (event) => {
    if (event.type !== EDITION_TEST_REQUESTED) return null;
    const p = event.props as unknown as EditionTestProps;
    const access = await deps.access(event.tenantId);
    const principal = systemPrincipal(event.tenantId, EDITION_TEST_SUBSCRIBER, access);
    if (access.status === 'suspended' || !entitled(principal, 'mailing.enabled')) return null;
    return deps.uow.run(principal, async (ctx): Promise<MailMessage | null> => {
      const member = await ctx.members.get(p.operatorId);
      const item = await ctx.content.get(p.itemId);
      if (!member || !item) return null;
      try {
        const mail = await editionLocale(ctx, item, p.locale, p.site);
        return {
          from: { email: deps.from.email, name: p.site.name },
          to: { email: member.email },
          subject: testSubject(p.locale, mail.subject),
          ...editionForViewing(mail, p.site),
          stream: 'transactional',
        };
      } catch (e) {
        if (e instanceof UseCaseError) return null;
        throw e;
      }
    });
  };
}

/** Sends the test after commit, from the outbox, once per request (`sendOnce`). */
export function editionTestMailSubscriber(deps: EditionMailDeps): Subscriber {
  const source = editionTestMailSource(deps);
  return {
    name: EDITION_TEST_SUBSCRIBER,
    types: [EDITION_TEST_REQUESTED],
    async handle(event) {
      const message = await source(event);
      if (message) await sendOnce(deps, event, EDITION_TEST_SUBSCRIBER, message);
    },
  };
}
