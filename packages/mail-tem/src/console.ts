// Development mailer: prints the message instead of sending it, so the double opt-in link can be
// followed from the terminal, and with `spoolDir` set also writes each message as JSON so a test
// can follow it (the e2e signup flow). Never selected in production: compose refuses
// MAILER=console and MAIL_SPOOL_DIR there. `wasSent` answers from the keys it has printed, so
// the send-once protocol behaves here as it does against a real provider.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MailMessage, Mailer, SendVerdict } from '@mycel/core';

export interface SpooledMail extends MailMessage {
  key: string;
  sentAt: string;
}

export class ConsoleMailer implements Mailer {
  #n = 0;
  readonly #keys = new Set<string>();

  constructor(
    private readonly log: (line: string) => void = (l) => console.log(l),
    private readonly spoolDir?: string
  ) {
    if (spoolDir) mkdirSync(spoolDir, { recursive: true });
  }

  async send(message: MailMessage, key: string): Promise<{ providerId: string }> {
    this.#n += 1;
    const id = `console-${this.#n}`;
    this.log(
      [
        `--- mail ${id} (${message.stream}) key=${key} ---`,
        `From: ${message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email}`,
        `To: ${message.to.email}`,
        `Subject: ${message.subject}`,
        '',
        message.text,
        '--- end mail ---',
      ].join('\n')
    );
    if (this.spoolDir) {
      const spooled: SpooledMail = { ...message, key, sentAt: new Date().toISOString() };
      const file = `${Date.now()}-${String(this.#n).padStart(4, '0')}.json`;
      writeFileSync(join(this.spoolDir, file), JSON.stringify(spooled, null, 2));
    }
    this.#keys.add(key);
    return { providerId: id };
  }

  async wasSent(key: string): Promise<SendVerdict> {
    return this.#keys.has(key) ? 'sent' : 'not_sent';
  }
}
