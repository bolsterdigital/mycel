// The worker's health port (brief #17a decision 6): `/readyz` fails when a loop stands still or
// a queue lags, `/healthz` never looks further, `/metrics` serves the queue gauges.

import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Metrics } from '@mycel/observability';
import { assessWorker, startWorkerHealth } from './health.js';

const NOW = 1_800_000_000_000;
const lag = { outboxLagSeconds: 3, outboxDead: 1, jobsLagSeconds: 4, jobsExhausted: 2 };
const base = {
  lag,
  ticks: { outbox: NOW - 1000, jobs: NOW - 2000 },
  now: NOW,
  intervalsMs: { outbox: 1000, jobs: 5000 },
  maxLagSeconds: 900,
};

describe('assessWorker', () => {
  it('is ready with fresh ticks and low lag, and reports the numbers', () => {
    expect(assessWorker(base)).toEqual({
      ok: true,
      db: 'ok',
      outboxTickAgeSeconds: 1,
      jobsTickAgeSeconds: 2,
      ...lag,
    });
  });

  it('fails when a loop stands still, has not ticked, the lag is too high or the db is down', () => {
    // The job loop's limit is 3 x 5 s + 30 s = 45 s.
    expect(assessWorker({ ...base, ticks: { ...base.ticks, jobs: NOW - 44_000 } }).ok).toBe(true);
    expect(assessWorker({ ...base, ticks: { ...base.ticks, jobs: NOW - 46_000 } }).ok).toBe(false);
    expect(assessWorker({ ...base, ticks: { ...base.ticks, outbox: null } })).toMatchObject({
      ok: false,
      outboxTickAgeSeconds: null,
    });
    expect(assessWorker({ ...base, lag: { ...lag, jobsLagSeconds: 900 } }).ok).toBe(false);
    expect(assessWorker({ ...base, lag: { ...lag, outboxLagSeconds: 901 } }).ok).toBe(false);
    expect(assessWorker({ ...base, lag: null })).toMatchObject({ ok: false, db: 'down' });
  });
});

describe('worker health port', () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  async function serve(stale: boolean) {
    const metrics = new Metrics();
    const gauge = metrics.gauge('mycel_jobs_lag_seconds', 'Lag');
    server = startWorkerHealth(0, {
      readiness: async () => {
        gauge.set(lag.jobsLagSeconds);
        return assessWorker({
          ...base,
          now: Date.now(),
          ticks: { outbox: Date.now(), jobs: stale ? Date.now() - 60_000 : Date.now() },
        });
      },
      metrics,
    });
    await new Promise((done) => server!.once('listening', done));
    const { port } = server.address() as AddressInfo;
    return (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  }

  it('answers /readyz 503 when the job loop stands still, 200 otherwise', async () => {
    const stale = await serve(true);
    const res = await stale('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false,
      jobsTickAgeSeconds: 60,
      jobsLagSeconds: 4,
    });
    expect((await stale('/healthz')).status).toBe(200);
    server?.close();

    const fresh = await serve(false);
    expect((await fresh('/readyz')).status).toBe(200);
    const metrics = await (await fresh('/metrics')).text();
    expect(metrics).toContain('mycel_jobs_lag_seconds 4');
    expect((await fresh('/nope')).status).toBe(404);
  });
});
