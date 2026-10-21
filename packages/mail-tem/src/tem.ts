// Scaleway Transactional Email adapter for the core `Mailer` port (ADR 010 rule 7). Ported from
// dreamkit-supporter-registry/src/tem/send.ts, not imported: same request shape, but it throws
// on failure so the outbox worker retries, instead of returning a result object to inspect.
// Uses global fetch (Node 22); rejected: the Scaleway SDK, a large dependency for one endpoint.

import type { MailMessage, Mailer } from '@mycel/core';

export interface TemConfig {
  secretKey: string;
  projectId: string;
  /** e.g. `fr-par`. */
  region: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export function buildTemRequestBody(
  message: MailMessage,
  projectId: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: { email: message.from.email, name: message.from.name ?? '' },
    to: [{ email: message.to.email, name: message.to.name ?? '' }],
    subject: message.subject,
    text: message.text,
    html: message.html,
    project_id: projectId,
  };
  if (message.headers && Object.keys(message.headers).length > 0)
    body['additional_headers'] = Object.entries(message.headers).map(([key, value]) => ({
      key,
      value,
    }));
  return body;
}

export class TemMailer implements Mailer {
  constructor(private readonly config: TemConfig) {
    if (!config.secretKey || !config.projectId)
      throw new Error('TEM mailer needs a secret key and a project id');
  }

  async send(message: MailMessage): Promise<{ id: string }> {
    const doFetch = this.config.fetch ?? fetch;
    const url = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${this.config.region}/emails`;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'X-Auth-Token': this.config.secretKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTemRequestBody(message, this.config.projectId)),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`TEM API ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { emails?: { id?: string }[] };
    return { id: json.emails?.[0]?.id ?? '' };
  }
}
