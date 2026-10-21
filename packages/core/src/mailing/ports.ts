// Sending is a port (ADR 010 rule 7): the adapter delivers, the mailing domain decides whether
// and what to send. First adapters: Scaleway TEM and a console mailer (packages/mail-tem).
//
// Every send is preceded by an intent row (`MailSend`, ADR 019 rule 6) whose key the adapter
// receives; a provider without an idempotency key (TEM) gets it as a header and answers
// `wasSent` from its own records. Rejected: a status enum on the intent row, which has to be kept
// in step with three transactions; the state is derived from which timestamps are set.

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

export type SendVerdict = 'sent' | 'not_sent' | 'unknown';

export interface Mailer {
  /** Deliver one message; `key` is the intent key (`<subscriber>:<event id>`), unique per message. */
  send(message: MailMessage, key: string): Promise<{ providerId: string }>;
  /**
   * Reconciliation (ADR 019 rule 6): did an earlier attempt with this key reach the provider?
   * `since` is when that attempt started. `unknown` means the caller must not retry yet.
   */
  wasSent(key: string, message: MailMessage, since: Date): Promise<SendVerdict>;
}

/**
 * One intent row per message. State is derived: no `attemptedAt` means never tried; `attemptedAt`
 * without `sentAt` means the outcome is unknown until reconciled; `sentAt` means done.
 */
export interface MailSend {
  key: string;
  subscriber: string;
  eventId: string;
  attemptedAt: Date | null;
  sentAt: Date | null;
  providerId: string | null;
  lastError: string | null;
}

export interface MailSendsRepository {
  get(key: string): Promise<MailSend | null>;
  /** Insert the intent when new and record that an attempt starts now. Commit before the provider call. */
  attempt(intent: Pick<MailSend, 'key' | 'subscriber' | 'eventId'>, at: Date): Promise<void>;
  sent(key: string, at: Date, providerId: string | null): Promise<void>;
  failed(key: string, error: string): Promise<void>;
}

declare module '../ports.js' {
  interface TransactionContext {
    mailSends: MailSendsRepository;
  }
}
