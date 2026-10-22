// Sending is a port (ADR 010 rule 7): the adapter delivers, the mailing domain decides whether
// and what to send. First adapters: Scaleway TEM and a console mailer (packages/mail-tem).
//
// Every send is preceded by an intent row (`MailSend`, ADR 019 rule 6) whose key the adapter
// receives. A provider without an idempotency key (TEM) cannot be asked "did this key arrive";
// it can only list what it accepted, so `lookup` returns provider ids and the core decides, by
// counting, whether one of them belongs to this intent (`settleIntent` in delivery.ts). Rejected:
// a status enum on the intent row, which has to be kept in step with three transactions; the
// state is derived from which timestamps are set (docs/reference/mail.md).

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
}

declare module '../ports.js' {
  interface TransactionContext {
    mailSends: MailSendsRepository;
  }
}
