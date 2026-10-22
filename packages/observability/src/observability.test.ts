// Redaction, log shape, error reports and metrics (brief #17a). The envelope is compared with a
// fixed fixture: a change in what leaves the process must show up as a diff in this file.

import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@mycel/core';
import { MemoryLogger } from '@mycel/core/testing';
import { runWithContext, requestIdFrom, setContext } from './context.js';
import {
  consoleErrorReporter,
  errorChain,
  parseDsn,
  sentryEnvelope,
  sentryErrorReporter,
} from './errors.js';
import { createLogger } from './logger.js';
import { Metrics } from './metrics.js';
import { scrub } from './index.js';
import { buildVersion, recordBuildInfo } from './version.js';

const lines = () => {
  const out: string[] = [];
  return { out, write: (l: string) => void out.push(l), json: () => out.map((l) => JSON.parse(l)) };
};
const NOW = () => new Date('2026-10-22T12:00:00.000Z');

describe('scrub', () => {
  it.each([
    ['upper case', 'unknown supporter Jan.Jansen@Example.NL', 'unknown supporter [email]'],
    ['plus address', 'to a+news@b.org failed', 'to [email] failed'],
    ['IDN', 'mail für <jan@bücher.de>', 'mail für <[email]>'],
    ['punycode', 'x@xn--bcher-kva.de', '[email]'],
    ['in a URL query', 'GET /c?to=a%40b.nl&x=1', 'GET /c?to=[email]&x=1'],
    ['no dot', 'admin@localhost', '[email]'],
    ['bearer', 'authorization: Bearer abc.def-ghi', 'authorization: [secret]'],
    ['api key', `key mycel_${'A'.repeat(43)} leaked`, 'key [secret] leaked'],
  ])('%s', (_, input, output) => expect(scrub(input)).toBe(output));

  it('leaves role names, package specifiers and stack frames alone', () => {
    for (const s of ['role mycel_authenticator', "from '@mycel/core'", 'at f (file:///a/b.js:1:2)'])
      expect(scrub(s)).toBe(s);
  });

  it('scrubs every link of a cause chain', () => {
    const e = new Error('outer a@b.nl', { cause: new Error('inner c@d.nl', { cause: 'e@f.nl' }) });
    const chain = errorChain(e);
    expect(chain.map((c) => c.message)).toEqual(['outer [email]', 'inner [email]', '[email]']);
    expect(chain.map((c) => c.stack ?? '').join()).not.toMatch(/@[bdf]\.nl/);
  });
});

describe('logger', () => {
  it('writes one JSON object per line with the context, scrubbed, without denied keys', () => {
    const { write, json } = lines();
    const log = createLogger({ service: 'api', write, now: NOW });
    runWithContext({ requestId: 'req-12345678' }, () => {
      setContext({ tenantId: 't1' });
      log.child({ actor: 'operator:o1' }).info('saved for x@y.nl', {
        email: 'x@y.nl',
        Payload: 'secret',
        note: 'by x@y.nl',
        count: 2,
        level: 'overwritten?',
      });
    });
    expect(json()).toEqual([
      {
        time: '2026-10-22T12:00:00.000Z',
        level: 'info',
        msg: 'saved for [email]',
        service: 'api',
        requestId: 'req-12345678',
        tenantId: 't1',
        actor: 'operator:o1',
        note: 'by [email]',
        count: 2,
      },
    ]);
  });

  it('drops lines below LOG_LEVEL', () => {
    const { write, out } = lines();
    const log = createLogger({ service: 'worker', level: 'warn', write });
    log.info('no');
    log.warn('yes');
    expect(out).toHaveLength(1);
  });

  it('keeps a valid incoming request id and replaces an invalid one', () => {
    expect(requestIdFrom('abc-12345678', () => 'fresh')).toBe('abc-12345678');
    for (const bad of [undefined, 'short', 'has space 12345', 'x'.repeat(65), 'a@b.nl-1234'])
      expect(requestIdFrom(bad, () => 'fresh')).toBe('fresh');
  });
});

describe('error reporting', () => {
  const error = () => {
    const e = new TypeError('no supporter for a@b.nl');
    e.stack =
      'TypeError: no supporter for a@b.nl\n    at ingest (/app/core/x.js:10:5)\n    at /app/node_modules/pg/y.js:2:3';
    return e;
  };

  it('console adapter: one error line with type, scrubbed message and stack', () => {
    const log = new MemoryLogger();
    consoleErrorReporter(log).capture(error(), { job: 'mail.reconcile' });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatchObject({
      level: 'error',
      message: 'no supporter for [email]',
      fields: { job: 'mail.reconcile', errorType: 'TypeError' },
    });
    expect(String(log.lines[0]!.fields['stack'])).toContain('at ingest');
    expect(JSON.stringify(log.lines)).not.toContain('a@b.nl');
  });

  it('parses a DSN, with and without a path prefix', () => {
    expect(parseDsn('https://pub@glitchtip.example.eu/3')).toEqual({
      url: 'https://glitchtip.example.eu/api/3/envelope/',
      publicKey: 'pub',
    });
    expect(parseDsn('https://pub@host.eu:8443/sentry/7').url).toBe(
      'https://host.eu:8443/sentry/api/7/envelope/'
    );
    expect(() => parseDsn('https://host.eu/3')).toThrow(/DSN/);
  });

  it('builds the envelope of the fixture: exception and tags only', () => {
    const body = runWithContext({ requestId: 'req-12345678', tenantId: 't1' }, () =>
      sentryEnvelope(
        error(),
        { tags: { route: '/v1/:name' } },
        {
          dsn: 'https://pub@host.eu/3',
          environment: 'production',
          release: '0.1.0',
          service: 'api',
          now: NOW,
          eventId: () => 'e'.repeat(32),
        }
      )
    );
    expect(body.split('\n').map((l) => JSON.parse(l))).toEqual([
      { event_id: 'e'.repeat(32), sent_at: '2026-10-22T12:00:00.000Z' },
      { type: 'event', content_type: 'application/json' },
      {
        event_id: 'e'.repeat(32),
        timestamp: 1792670400,
        platform: 'node',
        level: 'error',
        environment: 'production',
        release: '0.1.0',
        tags: { service: 'api', requestId: 'req-12345678', tenantId: 't1', route: '/v1/:name' },
        exception: {
          values: [
            {
              type: 'TypeError',
              value: 'no supporter for [email]',
              stacktrace: {
                frames: [
                  {
                    function: '<anonymous>',
                    filename: '/app/node_modules/pg/y.js',
                    lineno: 2,
                    colno: 3,
                    in_app: false,
                  },
                  {
                    function: 'ingest',
                    filename: '/app/core/x.js',
                    lineno: 10,
                    colno: 5,
                    in_app: true,
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const event = JSON.parse(body.split('\n')[2]!);
    for (const absent of ['request', 'user', 'contexts', 'extra', 'server_name'])
      expect(event).not.toHaveProperty(absent);
  });

  it('posts with the auth header, fire and forget', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    sentryErrorReporter({
      dsn: 'https://pub@host.eu/3',
      environment: 'test',
      service: 'worker',
      log: noopLogger,
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).capture(error());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://host.eu/api/3/envelope/');
    expect((init.headers as Record<string, string>)['x-sentry-auth']).toMatch(
      /^Sentry sentry_version=7, sentry_key=pub, /
    );
    expect(String(init.body)).not.toContain('a@b.nl');
  });

  it('does not throw and logs a warning when the tracker times out', async () => {
    const log = new MemoryLogger();
    const hang: typeof globalThis.fetch = (_, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')))
      );
    const reporter = sentryErrorReporter({
      dsn: 'https://pub@host.eu/3',
      environment: 'test',
      service: 'api',
      log,
      fetch: hang,
      timeoutMs: 20,
    });
    expect(() => reporter.capture(error())).not.toThrow();
    await vi.waitFor(() => expect(log.lines).toHaveLength(1));
    expect(log.lines[0]).toMatchObject({ level: 'warn', message: 'error report not sent' });
  });
});

describe('metrics', () => {
  it('renders counters and gauges in the Prometheus text format', () => {
    const m = new Metrics();
    const c = m.counter('mycel_http_requests_total', 'Requests');
    c.inc({ route: '/v1/:name', method: 'POST', status: '2xx' });
    c.inc({ method: 'POST', status: '2xx', route: '/v1/:name' });
    c.inc({ method: 'GET', route: 'a"b\\c', status: '4xx' });
    m.gauge('mycel_jobs_lag_seconds', 'Lag').set(12);
    expect(m.render()).toBe(
      [
        '# HELP mycel_http_requests_total Requests',
        '# TYPE mycel_http_requests_total counter',
        'mycel_http_requests_total{method="POST",route="/v1/:name",status="2xx"} 2',
        'mycel_http_requests_total{method="GET",route="a\\"b\\\\c",status="4xx"} 1',
        '# HELP mycel_jobs_lag_seconds Lag',
        '# TYPE mycel_jobs_lag_seconds gauge',
        'mycel_jobs_lag_seconds 12',
        '',
      ].join('\n')
    );
  });

  it('exposes the build version as mycel_build_info', () => {
    const m = new Metrics();
    recordBuildInfo(m, '1.2.3');
    expect(m.render()).toContain('mycel_build_info{version="1.2.3"} 1');
  });
});

describe('buildVersion', () => {
  it('prefers MYCEL_VERSION from the image over package.json', () => {
    expect(buildVersion('0.1.0-rc.1')).toBe('0.1.0-rc.1');
  });

  it('falls back to the root package.json', () => {
    expect(buildVersion(' ')).toMatch(/^\d+\.\d+\.\d+/);
  });
});
