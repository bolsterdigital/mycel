// Error reporting behind the core's `ErrorReporter` port: a console adapter (one `error` line)
// and a Sentry-envelope adapter that GlitchTip (self-hosted, EU) accepts as well. One `fetch` of
// one envelope instead of `@sentry/node` (ADR 008 rule 1): that SDK instruments everything it can
// reach and sends request data by default, while we send only the exception and a few tags. No
// body, no headers, no cookies, no user, no IP; message and stack scrubbed like a log line.

import { randomBytes } from 'node:crypto';
import { errorFields, scrubText, type ErrorReporter, type Logger } from '@mycel/core';
import { currentContext } from './context.js';

type CaptureContext = Parameters<ErrorReporter['capture']>[1];

export interface ScrubbedError {
  type: string;
  message: string;
  stack: string | undefined;
}

/** The error and its `cause` chain, outermost first, each scrubbed. Stops at ten links. */
export function errorChain(error: unknown): ScrubbedError[] {
  const chain: ScrubbedError[] = [];
  for (let e: unknown = error, i = 0; e !== undefined && e !== null && i < 10; i++) {
    chain.push(
      e instanceof Error
        ? {
            type: e.name,
            message: scrubText(e.message),
            stack: e.stack === undefined ? undefined : scrubText(e.stack),
          }
        : { type: typeof e, message: scrubText(String(e)), stack: undefined }
    );
    e = e instanceof Error ? e.cause : undefined;
  }
  return chain;
}

/** Explicit context wins over the ambient one; tags are flattened next to it. */
function tagsOf(context: CaptureContext): Record<string, string> {
  const ambient = currentContext();
  const tags: Record<string, string | undefined> = {
    requestId: context?.requestId ?? ambient.requestId,
    tenantId: context?.tenantId ?? ambient.tenantId,
    job: context?.job ?? ambient.job,
    ...context?.tags,
  };
  return Object.fromEntries(
    Object.entries(tags).filter((e): e is [string, string] => e[1] !== undefined)
  );
}

export function consoleErrorReporter(log: Logger): ErrorReporter {
  return {
    capture(error, context) {
      const [head, ...causes] = errorChain(error);
      log.error(head?.message ?? 'error', {
        ...tagsOf(context),
        errorType: head?.type ?? 'unknown',
        stack: [head, ...causes]
          .map((e) => e?.stack ?? `${e?.type}: ${e?.message}`)
          .join('\nCaused by: '),
      });
    },
  };
}

/** `https://<key>@<host>[/<path>]/<project>` to the envelope endpoint and the public key. */
export function parseDsn(dsn: string): { url: string; publicKey: string } {
  const u = new URL(dsn);
  const project = u.pathname.split('/').filter(Boolean).pop();
  if (!u.username || !project) throw new Error('ERROR_REPORTING_DSN is not a Sentry DSN');
  const path = u.pathname.slice(0, u.pathname.lastIndexOf('/'));
  return { url: `${u.protocol}//${u.host}${path}/api/${project}/envelope/`, publicKey: u.username };
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** V8 stack lines as Sentry frames, oldest call first as Sentry expects. */
function framesOf(stack: string | undefined) {
  return (stack ?? '')
    .split('\n')
    .map((line) => FRAME.exec(line))
    .filter((m) => m !== null)
    .map(([, fn, file, line, col]) => ({
      function: fn ?? '<anonymous>',
      filename: file,
      lineno: Number(line),
      colno: Number(col),
      in_app: !file?.includes('node_modules'),
    }))
    .reverse();
}

export interface SentryOptions {
  dsn: string;
  environment: string;
  release?: string | undefined;
  service: string;
  now?: () => Date;
  eventId?: () => string;
}

/** The envelope body: envelope header, item header, event; one JSON document per line. */
export function sentryEnvelope(error: unknown, context: CaptureContext, o: SentryOptions): string {
  const at = (o.now ?? (() => new Date()))();
  const eventId = (o.eventId ?? (() => randomBytes(16).toString('hex')))();
  const event = {
    event_id: eventId,
    timestamp: at.getTime() / 1000,
    platform: 'node',
    level: 'error',
    environment: o.environment,
    ...(o.release ? { release: o.release } : {}),
    tags: { service: o.service, ...tagsOf(context) },
    exception: {
      // Sentry lists the root cause first and the error that was thrown last.
      values: errorChain(error)
        .reverse()
        .map((e) => ({
          type: e.type,
          value: e.message,
          stacktrace: { frames: framesOf(e.stack) },
        })),
    },
  };
  return [
    JSON.stringify({ event_id: eventId, sent_at: at.toISOString() }),
    JSON.stringify({ type: 'event', content_type: 'application/json' }),
    JSON.stringify(event),
  ].join('\n');
}

/**
 * Fire and forget with a two-second time-out: `capture` returns at once, and a tracker that is
 * down costs one `warn` line per error, never a failed request or job.
 */
export function sentryErrorReporter(
  options: SentryOptions & {
    log: Logger;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }
): ErrorReporter {
  const { url, publicKey } = parseDsn(options.dsn);
  const send = options.fetch ?? fetch;
  const auth = `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=mycel/0.0.0`;
  return {
    capture(error, context) {
      let body: string;
      try {
        body = sentryEnvelope(error, context, options);
      } catch (e) {
        options.log.warn('error report not built', { error: String(e) });
        return;
      }
      void send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': auth },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
      })
        .then((res) => {
          if (!res.ok) options.log.warn('error report refused', { status: res.status });
        })
        .catch((e: unknown) => options.log.warn('error report not sent', errorFields(e)));
    },
  };
}
