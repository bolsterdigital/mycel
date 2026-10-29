// Redaction conformance (brief #17a, ADR 019 rule 8): no e-mail address reaches a log line or an
// error report from the HTTP front. Generic over the registry, so it grows with every use case:
// each one is called by an operator principal that carries an address, with an address in the
// body, over a unit of work that fails with an address in its message. Plus every UseCaseError
// code with an address in its message, and the Sentry envelope of the same failures.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCESS,
  Invoker,
  UseCaseError,
  buildRegistry,
  type Principal,
  type UnitOfWork,
  type UseCaseErrorCode,
} from '@mycel/core';
import {
  Metrics,
  consoleErrorReporter,
  createLogger,
  sentryErrorReporter,
} from '@mycel/observability';
import { TENANT } from '@mycel/core/testing';
import { createApp } from './app.js';

const ADDRESS = 'jan.jansen@example.org';

const operator: Principal = {
  tenantId: TENANT,
  actor: { kind: 'operator', operatorId: 'op-1', email: ADDRESS },
  capabilities: ['tenant:admin'],
  entitlements: DEFAULT_ACCESS.entitlements,
  tenantStatus: DEFAULT_ACCESS.status,
};

/** A unit of work whose every transaction fails, quoting an address like a driver error might. */
const failing: UnitOfWork = {
  run: async () => {
    throw new Error(`duplicate key: (email)=(${ADDRESS})`, {
      cause: new Error(`while ingesting ${ADDRESS}`),
    });
  },
};

function harness(invoker: Pick<Invoker, 'registry' | 'call' | 'run'>) {
  const out: string[] = [];
  const bodies: string[] = [];
  const log = createLogger({ service: 'api', write: (l) => void out.push(l) });
  const console = consoleErrorReporter(log);
  const sentry = sentryErrorReporter({
    dsn: 'https://pub@tracker.example.eu/1',
    environment: 'test',
    service: 'api',
    log,
    fetch: async (_, init) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 200 });
    },
  });
  let captured = 0;
  const app = createApp({
    invoker: invoker as Invoker,
    authenticate: async () => operator,
    observability: {
      log,
      errors: {
        capture(e, c) {
          captured += 1;
          console.capture(e, c);
          sentry.capture(e, c);
        },
      },
      metrics: new Metrics(),
    },
  });
  const post = (name: string) =>
    app.request(`/v1/${name}`, {
      method: 'POST',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADDRESS, values: { email: ADDRESS }, note: ADDRESS }),
    });
  return { out, bodies, post, captured: () => captured };
}

describe('redaction conformance', () => {
  it('keeps the address out of every log line and report, for every use case', async () => {
    const registry = buildRegistry();
    const h = harness(new Invoker(registry, failing));
    for (const useCase of registry.list()) await h.post(useCase.name);
    // Some use cases reached the failing unit of work: the internal path is exercised.
    expect(h.captured()).toBeGreaterThan(0);
    await new Promise((done) => setTimeout(done, 10));
    expect(h.bodies.length).toBe(h.captured());
    expect(h.out.join('\n')).toContain('[email]');
    expect(h.out.join('\n')).not.toContain(ADDRESS);
    expect(h.bodies.join('\n')).not.toContain(ADDRESS);
  });

  const codes: UseCaseErrorCode[] = [
    'not_found',
    'forbidden',
    'invalid_input',
    'conflict',
    'limit_exceeded',
    'suspended',
  ];
  it.each(codes)('reports no UseCaseError (%s) and logs no address from it', async (code) => {
    const registry = buildRegistry();
    const h = harness({
      registry,
      run: async () => {
        throw new UseCaseError(code, `refused for ${ADDRESS}`);
      },
      call: async () => {
        throw new UseCaseError(code, `refused for ${ADDRESS}`);
      },
    });
    await h.post(registry.list()[0]!.name);
    expect(h.captured()).toBe(0);
    expect(h.out).toHaveLength(1); // the access line
    expect(h.out.join('\n')).not.toContain(ADDRESS);
  });
});
