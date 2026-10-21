// Sending is a port (ADR 010 rule 7): the adapter delivers, the mailing domain decides whether
// and what to send. First adapters: Scaleway TEM and a console mailer (packages/mail-tem).

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

export interface Mailer {
  send(message: MailMessage): Promise<{ id: string }>;
}
