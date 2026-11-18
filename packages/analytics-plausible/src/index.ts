// The Plausible transport of the `Analytics` port (docs/reference/analytics.md § Server events):
// one POST to the Events API per delivery, built from the closed `AnalyticsDelivery` and nothing
// else. The endpoint is core's `PLAUSIBLE_EVENT_ENDPOINT`, the same constant the browser script
// and the CSP use; only a test may point it at loopback. No visitor header exists here to forward:
// the user agent is Mycel's own, there is no X-Forwarded-For, cookie or referrer, so Plausible
// sees the worker, and a server event is a count, never a visitor.
// Each answer maps to one `AnalyticsOutcome`, and only an answer that proves nothing was processed
// is `retryable`, because the Events API has no idempotency key: a resend of a request that may
// have arrived counts twice.
// Rejected: following redirects (an answer from elsewhere is not Plausible's), reading the
// response body (nothing in it changes the outcome, and it is the provider's text we would then
// have to keep out of logs), and a timeout of tens of seconds (the outbox drains a batch serially
// in one transaction, so a slow provider would hold up the confirmation mails behind it).

import {
  PLAUSIBLE_EVENT_ENDPOINT,
  type Analytics,
  type AnalyticsDelivery,
  type AnalyticsOutcome,
} from '@mycel/core';

/** Per attempt; the subscriber makes at most two, so a dead provider costs the drain six seconds. */
export const PLAUSIBLE_TIMEOUT_MS = 3000;

/** Mycel's own user agent: Plausible requires one, and it describes the worker, not a visitor. */
export const PLAUSIBLE_USER_AGENT = 'Mycel (server event)';

/** Connection errors that happen before a request byte leaves this process. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

export interface PlausibleOptions {
  /** A loopback recorded-answer server in tests; the platform's Plausible otherwise. */
  endpoint?: string;
  timeoutMs?: number;
}

/** The Events API body: name, URL, site and the catalogue props, nothing else. */
export function plausibleBody(delivery: AnalyticsDelivery) {
  return {
    name: delivery.event.name,
    url: delivery.url,
    domain: delivery.domain,
    props: delivery.event.props,
  };
}

/** What a Plausible answer means for the delivery; exported for the fixture tests. */
export function plausibleOutcome(status: number, headers: Headers): AnalyticsOutcome {
  // Plausible says 202 for a site it does not know too, and drops the event; resending cannot
  // help, so that is a refusal, not an acceptance.
  if (status >= 200 && status < 300)
    return headers.get('x-plausible-dropped') === '1' ? 'rejected' : 'accepted';
  // Rate limited, or a proxy with no Plausible behind it: the event was not processed.
  if (status === 429 || status === 503) return 'retryable';
  if (status >= 300 && status < 500) return 'rejected';
  return 'unknown';
}

const causeCode = (error: unknown): string | undefined => {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
};

export class PlausibleAnalytics implements Analytics {
  readonly #endpoint: string;
  readonly #timeoutMs: number;

  constructor(options: PlausibleOptions = {}) {
    const endpoint = options.endpoint ?? PLAUSIBLE_EVENT_ENDPOINT;
    if (endpoint !== PLAUSIBLE_EVENT_ENDPOINT && !/^http:\/\/127\.0\.0\.1:[0-9]+\//.test(endpoint))
      throw new Error('the Plausible endpoint is the platform constant or a loopback fixture');
    this.#endpoint = endpoint;
    this.#timeoutMs = options.timeoutMs ?? PLAUSIBLE_TIMEOUT_MS;
  }

  async send(delivery: AnalyticsDelivery): Promise<AnalyticsOutcome> {
    let response: Response;
    try {
      response = await fetch(this.#endpoint, {
        method: 'POST',
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { 'content-type': 'application/json', 'user-agent': PLAUSIBLE_USER_AGENT },
        body: JSON.stringify(plausibleBody(delivery)),
      });
    } catch (error) {
      // A refused or unresolvable connection sent nothing; a timeout or a reset may have.
      return NOT_SENT.has(causeCode(error) ?? '') ? 'retryable' : 'unknown';
    }
    await response.body?.cancel().catch(() => undefined);
    return plausibleOutcome(response.status, response.headers);
  }
}
