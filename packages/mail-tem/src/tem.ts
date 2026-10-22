// Scaleway Transactional Email adapter for the core `Mailer` port (ADR 010 rule 7). Ported from
// dreamkit-supporter-registry/src/tem/send.ts, not imported: same request shape, but it throws
// on failure so the outbox worker retries, instead of returning a result object to inspect.
// Uses global fetch (Node 22); rejected: the Scaleway SDK, a large dependency for one endpoint.
//
// TEM has no idempotency key. The intent key travels as `X-Mycel-Send-Key` for investigation;
// `lookup` lists the project's e-mails to the recipient with the subject in a window, every
// status (`failed`/`canceled` still means TEM accepted it), and the core counts (`settleIntent`,
// docs/reference/mail.md). Rejected: matching on the header, which neither the `Email` object
// nor the list filter carries; `mail_to`, deprecated for `mail_rcpt`; and a `statuses` filter,
// which gave internal errors in the Dreamkit notifier.

import { SEND_TIMEOUT_MS, type MailMessage, type MailWindow, type Mailer } from '@mycel/core';

export interface TemConfig {
  secretKey: string;
  projectId: string;
  /** e.g. `fr-par`. */
  region: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** `SEND_TIMEOUT_MS` unless set; the core's claim lease assumes that default. */
  timeoutMs?: number;
}

export const SEND_KEY_HEADER = 'X-Mycel-Send-Key';

/** One page of the listing; more matches than this is an answer the core cannot count. */
const LOOKUP_PAGE_SIZE = 100;

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
      signal: AbortSignal.timeout(this.config.timeoutMs ?? SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`TEM API ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { emails?: { id?: string }[] };
    return { providerId: json.emails?.[0]?.id ?? '' };
  }

  async lookup(
    message: MailMessage,
    { since, until }: MailWindow
  ): Promise<{ providerIds: string[] } | null> {
    const doFetch = this.config.fetch ?? fetch;
    const query = new URLSearchParams({
      project_id: this.config.projectId,
      mail_rcpt: message.to.email,
      subject: message.subject,
      since: since.toISOString(),
      until: until.toISOString(),
      page_size: String(LOOKUP_PAGE_SIZE),
    });
    try {
      const res = await doFetch(`${this.#url('emails')}?${query}`, {
        headers: { 'X-Auth-Token': this.config.secretKey },
        signal: AbortSignal.timeout(this.config.timeoutMs ?? SEND_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { total_count?: unknown; emails?: { id?: unknown }[] };
      if (typeof json.total_count !== 'number' || !Array.isArray(json.emails)) return null;
      const ids = json.emails.map((e) => e.id);
      if (json.total_count > ids.length || !ids.every((id) => typeof id === 'string' && id))
        return null;
      return { providerIds: ids as string[] };
    } catch {
      return null;
    }
  }
}
