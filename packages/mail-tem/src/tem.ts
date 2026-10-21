// Scaleway Transactional Email adapter for the core `Mailer` port (ADR 010 rule 7). Ported from
// dreamkit-supporter-registry/src/tem/send.ts, not imported: same request shape, but it throws
// on failure so the outbox worker retries, instead of returning a result object to inspect.
// Uses global fetch (Node 22); rejected: the Scaleway SDK, a large dependency for one endpoint.
//
// TEM has no idempotency key. The intent key travels as `X-Mycel-Send-Key` for investigation,
// and `wasSent` reconciles (ADR 019 rule 6) by listing the project's e-mails to the recipient
// since the attempt, matched on subject. Rejected: matching on the header, which the list
// endpoint does not return.

import type { MailMessage, Mailer, SendVerdict } from '@mycel/core';

export interface TemConfig {
  secretKey: string;
  projectId: string;
  /** e.g. `fr-par`. */
  region: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export const SEND_KEY_HEADER = 'X-Mycel-Send-Key';

/** Clock skew between this process and the provider's `created_at`. */
const RECONCILE_SLACK_MS = 60_000;

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

  #url(path: string): string {
    return `https://api.scaleway.com/transactional-email/v1alpha1/regions/${this.config.region}/${path}`;
  }

  async send(message: MailMessage, key: string): Promise<{ providerId: string }> {
    const doFetch = this.config.fetch ?? fetch;
    const withKey = { ...message, headers: { ...message.headers, [SEND_KEY_HEADER]: key } };
    const res = await doFetch(this.#url('emails'), {
      method: 'POST',
      headers: { 'X-Auth-Token': this.config.secretKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTemRequestBody(withKey, this.config.projectId)),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`TEM API ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { emails?: { id?: string }[] };
    return { providerId: json.emails?.[0]?.id ?? '' };
  }

  async wasSent(_key: string, message: MailMessage, since: Date): Promise<SendVerdict> {
    const doFetch = this.config.fetch ?? fetch;
    const query = new URLSearchParams({
      project_id: this.config.projectId,
      mail_to: message.to.email,
      subject: message.subject,
      since: new Date(since.getTime() - RECONCILE_SLACK_MS).toISOString(),
      page_size: '1',
    });
    let res: Response;
    try {
      res = await doFetch(`${this.#url('emails')}?${query}`, {
        headers: { 'X-Auth-Token': this.config.secretKey },
      });
    } catch {
      return 'unknown';
    }
    if (!res.ok) return 'unknown';
    const json = (await res.json().catch(() => null)) as { total_count?: number } | null;
    if (!json || typeof json.total_count !== 'number') return 'unknown';
    return json.total_count > 0 ? 'sent' : 'not_sent';
  }
}
