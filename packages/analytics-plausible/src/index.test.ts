// Plausible's answers come from files in ../fixtures: two recorded from the platform's Plausible
// for a site it does not know (dropped, invalid), the rest in the shape the Events API documents.
// A loopback server plays Plausible, so the adapter's real request (method, headers, body,
// timeout) is exercised without a network. The last block runs the core subscriber over this
// transport: a pre-send failure is retried once, an answer that may have counted is not, and a
// redelivered intent sends nothing.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANALYTICS_INTENT,
  PLAUSIBLE_EVENT_ENDPOINT,
  deliverAnalyticsIntent,
  systemPrincipal,
  type AnalyticsDelivery,
  type DomainEvent,
} from '@mycel/core';
import {
  FakeClock,
  MemoryLogger,
  MemoryTenants,
  MemoryUnitOfWork,
  TENANT,
  hostedPlatform,
  probeTenant,
} from '@mycel/core/testing';
import {
  PLAUSIBLE_USER_AGENT,
  PlausibleAnalytics,
  plausibleBody,
  plausibleOutcome,
} from './index.js';

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
}
const fixture = (name: string): Answer =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
});

/** A Plausible on loopback that answers each request from `answers` in turn, the last repeating. */
async function plausible(...answers: Answer[]): Promise<{ endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const answer = answers[Math.min(seen.length, answers.length) - 1]!;
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(answer.status, answer.headers ?? {});
        res.end(answer.body ?? '');
      }, answer.delayMs ?? 0);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('no TCP address');
  return { endpoint: `http://127.0.0.1:${bound.port}/api/event`, seen };
}

const DELIVERY: AnalyticsDelivery = {
  domain: 'example.org',
  url: 'https://example.org/',
  event: { name: 'form.submitted', props: { kind: 'signup' } },
};

describe('Plausible transport', () => {
  it('posts the closed event and no visitor header', async () => {
    const { endpoint, seen } = await plausible(fixture('accepted'));
    expect(await new PlausibleAnalytics({ endpoint }).send(DELIVERY)).toBe('accepted');
    expect(seen).toHaveLength(1);
    const [request] = seen as [Seen];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/event');
    expect(JSON.parse(request.body)).toEqual({
      name: 'form.submitted',
      url: 'https://example.org/',
      domain: 'example.org',
      props: { kind: 'signup' },
    });
    expect(request.headers['user-agent']).toBe(PLAUSIBLE_USER_AGENT);
    expect(request.headers['content-type']).toBe('application/json');
    for (const header of ['x-forwarded-for', 'cookie', 'referer', 'authorization', 'origin'])
      expect(request.headers[header]).toBeUndefined();
  });

  it('reads each recorded and documented answer into one outcome', () => {
    const outcome = (name: string) => {
      const { status, headers } = fixture(name);
      return plausibleOutcome(status, new Headers(headers));
    };
    expect(outcome('accepted')).toBe('accepted');
    // Plausible takes the request and drops the event for a site it does not know.
    expect(outcome('dropped')).toBe('rejected');
    expect(outcome('invalid')).toBe('rejected');
    expect(outcome('rate-limited')).toBe('retryable');
    expect(outcome('unavailable')).toBe('retryable');
    expect(outcome('server-error')).toBe('unknown');
    expect(plausibleOutcome(302, new Headers({ location: 'https://elsewhere.example/' }))).toBe(
      'rejected'
    );
  });

  it('does not follow a redirect', async () => {
    const elsewhere = await plausible(fixture('accepted'));
    const { endpoint } = await plausible({
      status: 307,
      headers: { location: elsewhere.endpoint },
    });
    expect(await new PlausibleAnalytics({ endpoint }).send(DELIVERY)).toBe('rejected');
    expect(elsewhere.seen).toHaveLength(0);
  });

  it('a timeout may have counted; a refused connection sent nothing', async () => {
    const slow = await plausible({ ...fixture('accepted'), delayMs: 500 });
    expect(
      await new PlausibleAnalytics({ endpoint: slow.endpoint, timeoutMs: 50 }).send(DELIVERY)
    ).toBe('unknown');
    expect(slow.seen).toHaveLength(1);

    const closed = await plausible(fixture('accepted'));
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await new PlausibleAnalytics({ endpoint: closed.endpoint }).send(DELIVERY)).toBe(
      'retryable'
    );
  });

  it('sends only to the platform constant or a loopback fixture', () => {
    expect(() => new PlausibleAnalytics()).not.toThrow();
    expect(() => new PlausibleAnalytics({ endpoint: PLAUSIBLE_EVENT_ENDPOINT })).not.toThrow();
    for (const endpoint of [
      'https://plausible.io/api/event',
      'http://10.0.0.1:8000/api/event',
      'http://127.0.0.1.example/api/event',
    ])
      expect(() => new PlausibleAnalytics({ endpoint })).toThrow();
  });

  it('builds the body from the delivery alone', () => {
    expect(Object.keys(plausibleBody(DELIVERY)).sort()).toEqual(['domain', 'name', 'props', 'url']);
  });
});

describe('the analytics subscriber over the Plausible transport', () => {
  async function setup(...answers: Answer[]) {
    const server = await plausible(...answers);
    const clock = new FakeClock();
    const uow = new MemoryUnitOfWork({ clock, platform: hostedPlatform });
    uow.store.addPlatformHostname({ ...probeTenant(TENANT), slug: 'probe' }, hostedPlatform.domain);
    await uow.run(systemPrincipal(TENANT, 'test'), async (ctx) => {
      const { version } = await ctx.analyticsSettings.get();
      await ctx.analyticsSettings.update(version, { plausibleDomain: 'example.org' });
    });
    const deps = {
      uow,
      tenants: new MemoryTenants([{ ...probeTenant(TENANT), slug: 'probe' }]),
      platform: hostedPlatform,
      analytics: new PlausibleAnalytics({ endpoint: server.endpoint, timeoutMs: 100 }),
      clock,
      log: new MemoryLogger(),
    };
    const intent = (): DomainEvent => ({
      id: crypto.randomUUID(),
      type: ANALYTICS_INTENT,
      tenantId: TENANT,
      occurredAt: clock.now(),
      actor: { kind: 'anonymous', channel: 'web' },
      props: { name: 'form.submitted', props: { kind: 'signup' } },
    });
    return { ...server, deps, intent };
  }

  it('sends an accepted intent once; a redelivery sends nothing', async () => {
    const { deps, intent, seen } = await setup(fixture('accepted'));
    const event = intent();
    expect(await deliverAnalyticsIntent(deps, event)).toBe('accepted');
    expect(await deliverAnalyticsIntent(deps, event)).toBe('duplicate');
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({
      domain: 'example.org',
      url: expect.any(String),
    });
    expect(new URL(JSON.parse(seen[0]!.body).url).search).toBe('');
  });

  it('retries a pre-send failure once, then stops', async () => {
    const twice = await setup(fixture('unavailable'));
    expect(await deliverAnalyticsIntent(twice.deps, twice.intent())).toBe('retryable');
    expect(twice.seen).toHaveLength(2);
    const recovers = await setup(fixture('rate-limited'), fixture('accepted'));
    expect(await deliverAnalyticsIntent(recovers.deps, recovers.intent())).toBe('accepted');
    expect(recovers.seen).toHaveLength(2);
  });

  it('never resends what may have counted', async () => {
    for (const answer of [fixture('server-error'), { ...fixture('accepted'), delayMs: 500 }]) {
      const { deps, intent, seen } = await setup(answer);
      expect(await deliverAnalyticsIntent(deps, intent())).toBe('unknown');
      expect(seen).toHaveLength(1);
    }
  });
});
