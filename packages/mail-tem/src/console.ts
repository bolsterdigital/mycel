// Development mailer: prints the message instead of sending it, so the double opt-in link can be
// followed from the terminal. Never selected in production (compose refuses MAILER=console there).

import type { MailMessage, Mailer } from '@mycel/core';

export class ConsoleMailer implements Mailer {
  #n = 0;
  constructor(private readonly log: (line: string) => void = (l) => console.log(l)) {}

  async send(message: MailMessage): Promise<{ id: string }> {
    this.#n += 1;
    const id = `console-${this.#n}`;
    this.log(
      [
        `--- mail ${id} (${message.stream}) ---`,
        `From: ${message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email}`,
        `To: ${message.to.email}`,
        `Subject: ${message.subject}`,
        '',
        message.text,
        '--- end mail ---',
      ].join('\n')
    );
    return { id };
  }
}
