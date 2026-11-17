// Sending an article as a newsletter (ADR 010 rules 6 to 9, ADR 012 rule 5, ADR 018 rule 4).
// `mailing.edition.send` makes an edition: per locale asked for, the revision that is published
// in that locale now, rendered once through the `EmailRenderer` and stored as it is. From then on
// nothing reads the article again: every recipient gets the stored mail of their locale, and a
// correction on the site changes no edition. A second send of the same article is a new edition.
//
// The send itself only records and plans. It writes the edition, publishes `mailing.edition.sent`
// (ids only, with the edition's id as the event's, so the per-recipient intents of ADR 019 rule 6
// hang off one outbox event) and plans the delivery job in the same transaction. The job hands
// the recipients to the provider (edition-delivery.ts); consent is read there, per recipient, at
// the moment of sending (ADR 019 rule 5), not here.
//
// What can be sent is what a visitor can read: a published locale of an article with
// `delivery.email`, public (ADR 016: a restricted article is not mailed). `mailing.edition.get`
// shows exactly that mail without sending, and `mailing.edition.test` sends it to the operator's
// own address only.
//
// Rejected: rendering per recipient at delivery (recipients of one send would get different mail
// when the article is corrected meanwhile, against rule 4), one edition per locale (a
// subscriber would then get the mail once per locale), and sending from inside the request (a
// list of thousands would hold the transaction, and a provider timeout would undo the edition).

import { z } from 'zod';
import { requireEntitled, withinLimit } from '../entitlements/guards.js';
import { notFound, UseCaseError } from '../errors.js';
import { Locale } from '../i18n/locale.js';
import { t } from '../i18n/index.js';
import { jobKey } from '../jobs/types.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { exampleId } from '../util/ids.js';
import { statusOf } from '../content/lifecycle.js';
import type { ItemRecord } from '../content/ports.js';
import { emailDocument, EmailSite, UNSUBSCRIBE_PLACEHOLDER, withUnsubscribeUrl } from './email.js';
import type { MailEditionLocale } from './ports.js';
import { UNSUBSCRIBE_PATH } from './unsubscribe.js';
import '../content/ports.js';
import '../entitlements/ports.js';
import '../jobs/ports.js';
import '../operators/ports.js';
import '../supporters/ports.js';
import './ports.js';

/** The outbox event of a send; its id is the edition's id. Ids only, never an address. */
export const EDITION_SENT = 'mailing.edition.sent';
export interface EditionSentProps {
  editionId: string;
  itemId: string;
  list: string;
  locales: string[];
}

/** The outbox event of a test; the address is read from the member row when it is sent. */
export const EDITION_TEST_REQUESTED = 'mailing.edition.test_requested';
export interface EditionTestProps {
  itemId: string;
  locale: string;
  operatorId: string;
  site: EmailSite;
}

const refuse = (issue: string, message: string, params?: Record<string, string>) =>
  new UseCaseError('conflict', message, [
    { path: '', message: issue, ...(params ? { params } : {}) },
  ]);

/**
 * One locale of an item as the mail an edition would hold, with its list. Refuses what may not be
 * mailed: anything but an article with `delivery.email`, a locale that is not published, and
 * restricted content.
 */
export async function editionLocale(
  ctx: TransactionContext,
  item: ItemRecord,
  locale: string,
  site: EmailSite
): Promise<MailEditionLocale & { list: string }> {
  const state = item.publication.find((s) => s.locale === locale);
  if (!state || statusOf(state) !== 'published' || !state.publishedRevisionId)
    throw refuse('mailing.edition.not-published', `${locale} is not published`, { locale });
  const revision = await ctx.content.revision(item.id, state.publishedRevisionId);
  if (!revision) throw notFound('revision');
  const doc = revision.document;
  if (doc.type !== 'article' || !doc.delivery.email)
    throw refuse('mailing.edition.no-delivery', 'the published article names no list to mail');
  if (doc.access.level !== 'public')
    throw refuse('mailing.edition.restricted', 'restricted content is not sent by e-mail');
  const email = await emailDocument(ctx, {
    item,
    doc,
    locale,
    site,
    unsubscribe: UNSUBSCRIBE_PLACEHOLDER,
  });
  if (!email.subject)
    throw refuse('mailing.edition.no-subject', `${locale} has no subject`, { locale });
  return {
    locale,
    revisionId: revision.id,
    subject: email.subject,
    ...ctx.emailRenderer.render(email),
    list: doc.delivery.email.listId,
  };
}

/** The mail as someone who is not a recipient sees it: the footer link leads to the plain page. */
const forViewing = (mail: { html: string; text: string }, site: EmailSite) =>
  withUnsubscribeUrl(mail, `${site.url}${UNSUBSCRIBE_PATH}`);

const OneLocale = z.object({ itemId: z.string().guid(), locale: Locale, site: EmailSite }).strict();
const EXAMPLE_SITE = { name: 'Probe', url: 'https://probe.example.org', defaultLocale: 'nl' };

export const getEdition = defineUseCase({
  name: 'mailing.edition.get',
  kind: 'query',
  description:
    'Read the newsletter a send would make of one published locale of an article, without sending: subject, HTML, text part, the list and how many confirmed subscribers it has now. Refuses a locale that is not published, an article without e-mail delivery and restricted content.',
  requires: 'content:read',
  input: OneLocale,
  output: z.object({
    subject: z.string(),
    html: z.string(),
    text: z.string(),
    list: z.string(),
    recipients: z.number().int().nonnegative(),
    revisionId: z.string().guid(),
  }),
  examples: [{ input: { itemId: exampleId(0x1), locale: 'nl', site: EXAMPLE_SITE } }],
  async handler(ctx, { itemId, locale, site }) {
    const item = await ctx.content.get(itemId);
    if (!item) throw notFound('content item');
    const made = await editionLocale(ctx, item, locale, site);
    return {
      subject: made.subject,
      ...forViewing(made, site),
      list: made.list,
      recipients: await ctx.supporters.countMembers(made.list),
      revisionId: made.revisionId,
    };
  },
});

export const testEdition = defineUseCase({
  name: 'mailing.edition.test',
  kind: 'command',
  description:
    "Send the newsletter of one published locale of an article to the operator's own address, as a test: the same mail a send would make, marked as a test in the subject, to nobody else and without making an edition.",
  requires: 'mailing:send',
  effect: 'send',
  // A test goes to the address of whoever asks; a key and an agent have none.
  actors: ['operator'],
  input: OneLocale,
  output: z.object({ status: z.literal('queued') }),
  examples: [{ input: { itemId: exampleId(0x1), locale: 'nl', site: EXAMPLE_SITE } }],
  async handler(ctx, { itemId, locale, site }) {
    const { principal } = ctx;
    requireEntitled(principal, 'mailing.enabled');
    if (principal.actor.kind !== 'operator')
      throw new UseCaseError('forbidden', 'only an operator has an address to test with');
    const item = await ctx.content.get(itemId);
    if (!item) throw notFound('content item');
    // Rendered here so a refusal is the operator's answer, not a silent job.
    await editionLocale(ctx, item, locale, site);
    const props: EditionTestProps = {
      itemId,
      locale,
      operatorId: principal.actor.operatorId,
      site,
    };
    await ctx.events.publish({
      id: ctx.ids.next(),
      type: EDITION_TEST_REQUESTED,
      tenantId: principal.tenantId,
      occurredAt: ctx.clock.now(),
      actor: principal.actor,
      props: { ...props },
    });
    return { status: 'queued' as const };
  },
});

export const sendEdition = defineUseCase({
  name: 'mailing.edition.send',
  kind: 'command',
  description:
    "Send an article as a newsletter to every confirmed subscriber of its list: stores the edition (per locale the published revision and the mail made from it, unchangeable afterwards) and plans its delivery. A subscriber gets the locale they signed up in when it is among `locales`, else the site's default locale, else the first. Refuses a locale that is not published, restricted content and a send past the monthly mail limit. Sending again makes a new edition.",
  requires: 'mailing:send',
  effect: 'send',
  consumes: 'mail.monthly_max',
  input: z
    .object({
      itemId: z.string().guid(),
      locales: z
        .array(Locale)
        .min(1)
        .max(20)
        .refine((l) => new Set(l).size === l.length, 'mailing.edition.locales.duplicate'),
      site: EmailSite,
    })
    .strict(),
  output: z.object({
    editionId: z.string().guid(),
    list: z.string(),
    recipients: z.number().int().nonnegative(),
    locales: z.array(z.string()),
    sentAt: z.string().datetime(),
  }),
  examples: [{ input: { itemId: exampleId(0x1), locales: ['nl'], site: EXAMPLE_SITE } }],
  async handler(ctx, { itemId, locales, site }) {
    const { principal } = ctx;
    requireEntitled(principal, 'mailing.enabled');
    const used = await ctx.usage.mailsThisMonth();
    // A tenant at its limit sends nothing, whatever the list holds; the exact count follows.
    withinLimit(ctx, 'mail.monthly_max', used);
    // Locked: two sends of one article serialise, and a publication cannot move between
    // reading the pointer and storing the edition.
    const item = await ctx.content.lock(itemId);
    if (!item) throw notFound('content item');
    const made = [];
    for (const locale of locales) made.push(await editionLocale(ctx, item, locale, site));
    const list = made[0]!.list;
    if (made.some((m) => m.list !== list))
      throw refuse('mailing.edition.lists-differ', 'the published locales name different lists');
    const recipients = await ctx.supporters.countMembers(list);
    withinLimit(ctx, 'mail.monthly_max', used, recipients);

    const id = ctx.ids.next();
    const now = ctx.clock.now();
    await ctx.mailEditions.insert({
      id,
      itemId,
      list,
      recipients,
      sentAt: now,
      locales: made.map(({ list: _list, ...locale }) => locale),
    });
    const props: EditionSentProps = { editionId: id, itemId, list, locales };
    await ctx.events.publish({
      id,
      type: EDITION_SENT,
      tenantId: principal.tenantId,
      occurredAt: now,
      actor: principal.actor,
      props: { ...props },
    });
    await ctx.jobs.enqueue({
      type: 'mailing.edition.deliver',
      key: jobKey('mailing.edition.deliver', id),
      runAt: now,
      payload: { editionId: id },
    });
    return { editionId: id, list, recipients, locales, sentAt: now.toISOString() };
  },
});

/** The subject of a test mail, in the mail's own language. */
export const testSubject = (locale: string, subject: string): string =>
  t(locale, 'mail.edition.test.subject', { subject });

export { forViewing as editionForViewing };
