// Sending is a port (ADR 010 rule 7): the adapter delivers, the mailing domain decides whether
// and what to send. First adapters: Scaleway TEM and a console mailer (packages/mail-tem).
//
// Every send is preceded by an intent row (`MailSend`, ADR 019 rule 6) whose key the adapter
// receives. A provider without an idempotency key (TEM) cannot be asked "did this key arrive";
// it can only list what it accepted, so `lookup` returns provider ids and the core decides, by
// counting, whether one of them belongs to this intent (`settleIntent` in send-attempts.ts). Rejected:
// a status enum on the intent row, which has to be kept in step with three transactions; the
// state is derived from which timestamps are set (docs/reference/mail.md).

import type { EmailDocument, RenderedEmail } from './email.js';

export interface MailAddress {
  email: string;
  name?: string;
}

export interface MailMessage {
  from: MailAddress;
  to: MailAddress;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe (RFC 8058) on bulk mail. */
  headers?: Record<string, string>;
  /** Transactional and bulk mail get separate queues and limits (ADR 010 rule 9). */
  stream: 'transactional' | 'bulk';
}

/** A closed time range on the provider's clock. */
export interface MailWindow {
  since: Date;
  until: Date;
}

export interface Mailer {
  /**
   * Deliver one message; `key` is the intent key (`<subscriber>:<event id>`), unique per message.
   * Throws on any failure, including one after the provider may have accepted the message.
   */
  send(message: MailMessage, key: string): Promise<{ providerId: string }>;
  /**
   * Every message the provider accepted for this recipient and subject in the window, in any
   * status. `null` when it cannot say completely: an error, no answer, or more than one page.
   * The adapter lists; it never judges which message is whose.
   */
  lookup(message: MailMessage, window: MailWindow): Promise<{ providerIds: string[] } | null>;
}

/**
 * One intent row per message. State is derived (docs/reference/mail.md): no `attemptedAt` means
 * new; `claimedUntil` in the future means in flight; `attemptedAt` without `sentAt` and with the
 * lease expired means unknown until reconciled; `sentAt` means done; `abandonedAt` means given up.
 */
export interface MailSend {
  key: string;
  subscriber: string;
  eventId: string;
  attemptedAt: Date | null;
  /** The lease of the attempt in flight; set by `claim`, moved to the failure time by `failed`. */
  claimedUntil: Date | null;
  attempts: number;
  sentAt: Date | null;
  abandonedAt: Date | null;
  providerId: string | null;
  lastError: string | null;
  /**
   * `sha256(tenant id, lower(recipient), subject)` as hex: intents that a provider listing cannot
   * tell apart share it. Never the address itself. Null on rows from before migration 0013.
   */
  correlation: string | null;
}

export type MailIntent = Pick<MailSend, 'key' | 'subscriber' | 'eventId'> & { correlation: string };

export interface MailSendsRepository {
  get(key: string): Promise<MailSend | null>;
  /**
   * Claim an attempt in one statement: insert the intent, or take it over when it is not sent,
   * not abandoned, its lease has expired and its `attemptedAt` is still `expected` (what the
   * caller read; null for a new intent). Returns the claimed row, or null when another caller
   * holds or took the claim. Commit before the provider call.
   */
  claim(
    intent: MailIntent,
    attempt: { at: Date; until: Date; expected: Date | null }
  ): Promise<MailSend | null>;
  sent(key: string, at: Date, providerId: string | null): Promise<void>;
  /** Record a failed call and end its lease at `at`: the outcome is unknown from then on. */
  failed(key: string, error: string, at: Date): Promise<void>;
  abandon(key: string, at: Date): Promise<void>;
  /** This tenant's intents with this correlation whose attempt started within the range. */
  siblings(correlation: string, attemptedWithin: MailWindow): Promise<MailSend[]>;
  /** Attempted, not sent, lease expired at `now`, abandoned or not: what #17 shows. */
  unresolved(now: Date): Promise<MailSend[]>;
  /**
   * Counts per day in `zone` since `since`: sent by `sentAt`, given up by `abandonedAt`, and
   * attempted without either and with the lease expired at `now` by `attemptedAt`. Only days
   * with a count; never an address.
   */
  daily(since: Date, now: Date, zone: string): Promise<MailDayCount[]>;
  /** How many attempts of this subscriber started at or after `since`: the throughput count. */
  attemptedSince(subscriber: string, since: Date): Promise<number>;
}

export interface MailDayCount {
  /** `YYYY-MM-DD` in the zone asked for. */
  day: string;
  sent: number;
  unknown: number;
  abandoned: number;
}

/**
 * Turns an item's mail model into table HTML and a text part (ADR 004 rule 2, ADR 010 rule 6):
 * the core knows no HTML. Pure and synchronous; first adapter `packages/render-email`.
 */
export interface EmailRenderer {
  render(email: EmailDocument): RenderedEmail;
}

/** One locale of an edition: the revision that was published then and the mail made from it. */
export interface MailEditionLocale {
  locale: string;
  revisionId: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * One send of one item to one list, as it was sent (ADR 018 rule 4). The repository can add an
 * edition and move its delivery state; nothing changes what was sent.
 */
export interface MailEdition {
  id: string;
  itemId: string;
  list: string;
  /** Confirmed members of the list when it was sent. */
  recipients: number;
  sentAt: Date;
  /** The last supporter id the delivery handled; null before the first. */
  deliveredThrough: string | null;
  /** When the delivery reached the end of the list. */
  completedAt: Date | null;
  locales: MailEditionLocale[];
}

/** An edition without its mail, for a list of what an item was sent as. */
export type MailEditionSummary = Omit<MailEdition, 'locales' | 'deliveredThrough'> & {
  locales: Pick<MailEditionLocale, 'locale' | 'subject'>[];
};

export interface MailEditionsRepository {
  insert(edition: Omit<MailEdition, 'deliveredThrough' | 'completedAt'>): Promise<void>;
  get(id: string): Promise<MailEdition | null>;
  /** The editions of one item, newest first. */
  forItem(itemId: string): Promise<MailEditionSummary[]>;
  advance(id: string, supporterId: string): Promise<void>;
  complete(id: string, at: Date): Promise<void>;
}

/** One mail of a welcome series: an item of the site, so many days after joining the list. */
export interface MailAutomationStep {
  itemId: string;
  delayDays: number;
}

/**
 * A welcome series (ADR 010 rule 10, MY-258): one per list, its steps in order of delay. Only
 * people who join the list while it is on get it, each step at most once (`MailAutomationRun`).
 */
export interface MailAutomation {
  id: string;
  list: string;
  enabled: boolean;
  steps: MailAutomationStep[];
  createdAt: Date;
  updatedAt: Date;
}

/** One person in one series: when they joined, and the last step position handled (-1: none). */
export interface MailAutomationRun {
  automationId: string;
  supporterId: string;
  startedAt: Date;
  through: number;
}

export interface MailAutomationsRepository {
  list(): Promise<MailAutomation[]>;
  get(id: string): Promise<MailAutomation | null>;
  forList(list: string): Promise<MailAutomation | null>;
  /** Insert or replace the series with this id, its steps included. */
  save(automation: MailAutomation): Promise<void>;
  /** Start the series for a person; false when they were in it before (once is once). */
  start(automationId: string, supporterId: string, at: Date): Promise<boolean>;
  run(automationId: string, supporterId: string): Promise<MailAutomationRun | null>;
  /** Mark position `through` handled; false when the run was already there or past it. */
  advance(automationId: string, supporterId: string, through: number): Promise<boolean>;
  /** Per series: how many people started it, and per position how many got that far. */
  reach(automationId: string): Promise<{ started: number; reached: number[] }>;
}

declare module '../ports.js' {
  interface TransactionContext {
    mailSends: MailSendsRepository;
    mailEditions: MailEditionsRepository;
    mailAutomations: MailAutomationsRepository;
    emailRenderer: EmailRenderer;
  }
}
