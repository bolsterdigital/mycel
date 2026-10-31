// Delivery of one transactional message per intent (ADR 019 rule 6, brief #22C). `sendOnce`
// claims an attempt, calls the provider and records the outcome; `settleIntent` decides what an
// attempt without an outcome became; `reconcileMail` is what the `mail.reconcile` job runs.
//
// The provider (TEM) has no idempotency key and cannot be asked about ours: it can only list the
// messages it accepted for a recipient and subject. So reconciliation counts. A listed id that no
// sibling intent (same tenant, recipient and subject, overlapping window) owns is ours only when
// exactly one such id and exactly one unresolved sibling exist; any other picture is `unknown`,
// and `unknown` is never resent. This proves "never resend blind" and "never count someone
// else's message as ours", not exactly-once: a message the provider lists only after the
// reconcile budget, once an empty listing let a resend go out, is a duplicate nobody sees. The
// budget (`RECONCILE_LAG_MS`, env MAIL_RECONCILE_LAG_MINUTES) is the knob. docs/reference/mail.md.
//
// Rejected: matching on recipient, subject and time alone (the `wasSent` of before, which closed
// intent B on the strength of message A), putting the key in the subject or a plus-address (seen
// by the recipient, and it moves the problem to every other provider), and an advisory lock per
// key (it does not outlive the three transactions, and proves nothing after a crash).

import type { JobOutcome } from '../jobs/ports.js';
import { jobKey } from '../jobs/types.js';
import type { Clock, DomainEvent, TransactionContext, UnitOfWork } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import { emailKey } from '../supporters/email-key.js';
import { errorMessage } from '../util/log.js';
import { scrubText } from '../util/scrub.js';
import type { MailMessage, MailSend, MailWindow, Mailer } from './ports.js';

const MINUTE = 60 * 1000;

/** The provider call is aborted after this (TemMailer). */
export const SEND_TIMEOUT_MS = 30 * 1000;
/** Time past the call's timeout for the outcome to be committed. */
export const CLAIM_SLACK_MS = 30 * 1000;
/** A claim's lease: a lease that expires without `sentAt` means the outcome is unknown. */
export const CLAIM_LEASE_MS = SEND_TIMEOUT_MS + CLAIM_SLACK_MS;
/** Clock skew between this process and the provider's `created_at`. */
export const CLOCK_SKEW_MS = MINUTE;
/**
 * How long after an attempt the provider's listing is trusted to show it. Scaleway documents no
 * indexing delay, so this is an assumption with a budget, not a fact (docs/reference/mail.md).
 */
export const RECONCILE_LAG_MS = 15 * MINUTE;
/** How often the job looks again while the outcome is unknown. */
export const RECONCILE_INTERVAL_MS = 10 * MINUTE;
/** After this, an attempt that is still unknown is given up and stays visible as abandoned. */
export const RECONCILE_GIVE_UP_MS = 24 * 60 * MINUTE;
/** Attempts proven not to have arrived before the intent is given up. */
export const MAX_SEND_ATTEMPTS = 3;

export interface DeliveryDeps {
  mailer: Mailer;
  clock: Clock;
  /** The intent row is tenant data and is written under RLS, like any use case (ADR 011 rule 3). */
  uow: UnitOfWork;
  /** `RECONCILE_LAG_MS` unless the configuration says otherwise. */
  reconcileLagMs?: number | undefined;
}

/**
 * Builds the message a subscriber sends for an event, or null when it sends none. The job
 * rebuilds it from the outbox event, so the address never has to be stored with the intent.
 */
export type MailSource = (event: DomainEvent) => Promise<MailMessage | null>;
/** Keyed by subscriber name; what `mail.reconcile` looks up. */
export type MailSources = Readonly<Record<string, MailSource>>;

export type SendOutcome = 'sent' | 'reconciled' | 'skipped' | 'deferred' | 'unknown' | 'abandoned';
export type Settlement = 'sent' | 'abandoned' | 'in_flight' | 'unknown' | 'reconciled' | 'not_sent';

/** Where the provider can have recorded an attempt that started at `at`. */
export const attemptWindow = (at: Date): MailWindow => ({
  since: new Date(at.getTime() - CLOCK_SKEW_MS),
  until: new Date(at.getTime() + SEND_TIMEOUT_MS + CLOCK_SKEW_MS),
});

/** The recipient and subject as one key: what a provider listing cannot tell apart. */
export const mailCorrelation = (tenantId: string, message: MailMessage): Promise<string> =>
  emailKey(tenantId, message.to.email, 'mail-correlation', message.subject);

export const intentKey = (subscriber: string, eventId: string): string =>
  `${subscriber}:${eventId}`;

const runAs =
  (deps: Pick<DeliveryDeps, 'uow'>, tenantId: string, subscriber: string) =>
  <T>(fn: (ctx: TransactionContext) => Promise<T>) =>
    deps.uow.run(systemPrincipal(tenantId, subscriber), fn);

/**
 * Claim an attempt and plan its reconciliation in the same transaction, so the job exists if
 * and only if the claim committed: a process that dies between the provider call and recording
 * the outcome still leaves a job that finds the outcome. Returns null when the claim was lost.
 */
export async function claimAttempt(
  ctx: TransactionContext,
  intent: { key: string; subscriber: string; eventId: string; correlation: string },
  { at, expected, lagMs }: { at: Date; expected: Date | null; lagMs: number }
): Promise<MailSend | null> {
  const row = await ctx.mailSends.claim(intent, {
    at,
    until: new Date(at.getTime() + CLAIM_LEASE_MS),
    expected,
  });
  if (!row) return null;
  // While a reconcile job runs it holds this key, so a claim it makes itself plans nothing new:
  // the running job's outcome plans the next look.
  await ctx.jobs.enqueue({
    type: 'mail.reconcile',
    key: jobKey('mail.reconcile', intent.key),
    runAt: new Date(at.getTime() + lagMs),
    payload: { key: intent.key, subscriber: intent.subscriber, eventId: intent.eventId },
  });
  return row;
}

/**
 * What became of the attempt recorded in `intent`, decided by counting (the file comment). Only
 * `reconciled` writes: it records the one unaccounted provider id as this intent's.
 */
export async function settleIntent(
  deps: Pick<DeliveryDeps, 'mailer' | 'uow' | 'reconcileLagMs'> & { tenantId: string },
  intent: MailSend,
  message: MailMessage,
  now: Date
): Promise<Settlement> {
  if (intent.sentAt) return 'sent';
  if (intent.abandonedAt) return 'abandoned';
  if (!intent.attemptedAt) return 'not_sent';
  // Someone is talking to the provider: an empty listing now would look like "not sent".
  if (intent.claimedUntil && intent.claimedUntil > now) return 'in_flight';
  const attempted = intent.attemptedAt.getTime();
  if (now.getTime() < attempted + (deps.reconcileLagMs ?? RECONCILE_LAG_MS)) return 'unknown';

  const found = await deps.mailer.lookup(message, attemptWindow(intent.attemptedAt));
  if (!found) return 'unknown';

  const run = runAs(deps, deps.tenantId, intent.subscriber);
  const correlation = intent.correlation ?? (await mailCorrelation(deps.tenantId, message));
  // Siblings whose window overlaps this attempt's: started within one window width either side.
  const reach = SEND_TIMEOUT_MS + 2 * CLOCK_SKEW_MS;
  const listed = await run((ctx) =>
    ctx.mailSends.siblings(correlation, {
      since: new Date(attempted - reach),
      until: new Date(attempted + reach),
    })
  );
  // A row from before 0013 has no correlation and is not listed; it is still its own sibling.
  const siblings = [intent, ...listed.filter((s) => s.key !== intent.key)];
  const known = new Set(siblings.flatMap((s) => (s.sentAt && s.providerId ? [s.providerId] : [])));
  const unaccounted = [...new Set(found.providerIds)].filter((id) => !known.has(id));
  // An abandoned sibling stays unresolved: it was given up because nobody could place its
  // message, and that message may be the one unaccounted id. Adopting it would close this intent
  // on someone else's message; this intent stays unknown and is given up in turn.
  const unresolved = siblings.filter((s) => !s.sentAt);

  if (unaccounted.length === 0) return 'not_sent';
  if (unaccounted.length === 1 && unresolved.length === 1) {
    await run((ctx) => ctx.mailSends.sent(intent.key, now, unaccounted[0]!));
    return 'reconciled';
  }
  return 'unknown';
}

/**
 * Send one message per intent key. Three transactions, deliberately not one: (1) the claim
 * (with its reconcile job) commits before the provider is called, (2) the call runs outside any
 * transaction, (3) the outcome is recorded. Never throws for the provider: a failure is recorded
 * and the job already planned in (1) reconciles it. An existing intent is settled first, and
 * sent again only when the count proves its last attempt never arrived.
 */
export async function sendOnce(
  deps: DeliveryDeps,
  event: Pick<DomainEvent, 'id' | 'tenantId'>,
  subscriber: string,
  message: MailMessage
): Promise<SendOutcome> {
  const key = intentKey(subscriber, event.id);
  const run = runAs(deps, event.tenantId, subscriber);

  const existing = await run((ctx) => ctx.mailSends.get(key));
  let expected: Date | null = null;
  if (existing) {
    const settled = await settleIntent(
      { ...deps, tenantId: event.tenantId },
      existing,
      message,
      deps.clock.now()
    );
    if (settled === 'sent') return 'skipped';
    if (settled === 'in_flight') return 'deferred';
    if (settled !== 'not_sent') return settled;
    if (existing.attempts >= MAX_SEND_ATTEMPTS) {
      await run((ctx) => ctx.mailSends.abandon(key, deps.clock.now()));
      return 'abandoned';
    }
    expected = existing.attemptedAt;
  }

  const correlation = await mailCorrelation(event.tenantId, message);
  const claimed = await run((ctx) =>
    claimAttempt(
      ctx,
      { key, subscriber, eventId: event.id, correlation },
      { at: deps.clock.now(), expected, lagMs: deps.reconcileLagMs ?? RECONCILE_LAG_MS }
    )
  );
  if (!claimed) return 'deferred';

  let providerId: string;
  try {
    ({ providerId } = await deps.mailer.send(message, key));
  } catch (e) {
    // Scrubbed: the provider's message may quote the recipient, and #17c shows this column.
    const error = scrubText(errorMessage(e));
    await run((ctx) => ctx.mailSends.failed(key, error, deps.clock.now()));
    return 'unknown';
  }
  // An accepted message without an id stays unaccounted for its siblings: they stay unknown.
  await run((ctx) => ctx.mailSends.sent(key, deps.clock.now(), providerId || null));
  return 'sent';
}

const TERMINAL: ReadonlySet<SendOutcome> = new Set(['sent', 'reconciled', 'skipped', 'abandoned']);

/**
 * The `mail.reconcile` job for one intent: settle or send, then either finish or look again in
 * `RECONCILE_INTERVAL_MS`, until `RECONCILE_GIVE_UP_MS` after the attempt, when the intent is
 * abandoned. Its own row and its own `next`: one uncertain message holds up no other job and
 * not the outbox.
 */
export async function reconcileMail(
  deps: DeliveryDeps,
  event: Pick<DomainEvent, 'id' | 'tenantId'>,
  subscriber: string,
  message: MailMessage
): Promise<JobOutcome> {
  const outcome = await sendOnce(deps, event, subscriber, message);
  if (TERMINAL.has(outcome)) return {};
  const now = deps.clock.now();
  const key = intentKey(subscriber, event.id);
  const run = runAs(deps, event.tenantId, subscriber);
  const intent = await run((ctx) => ctx.mailSends.get(key));
  if (intent?.attemptedAt && now.getTime() >= intent.attemptedAt.getTime() + RECONCILE_GIVE_UP_MS) {
    await run((ctx) => ctx.mailSends.abandon(key, now));
    return {};
  }
  return { next: new Date(now.getTime() + RECONCILE_INTERVAL_MS) };
}
