// The worker's health port (brief #17a decisions 6 to 8). `/healthz` says the process lives and
// never looks further, so the compose healthcheck cannot restart a worker for a backlog. `/readyz`
// says whether it works: the database answers, both loops completed a pass recently, and neither
// queue lags past READY_MAX_LAG_SECONDS. `/metrics` has no token here: the port is internal and
// the Caddyfile keeps it unreachable from outside. Rejected: a heartbeat file checked by a second
// command, which would give the worker a healthcheck of its own.

import { createServer, type Server } from 'node:http';
import { METRICS_CONTENT_TYPE, type Metrics } from '@mycel/observability';
import type { QueueLag } from '@mycel/db';

export interface WorkerReadiness extends Partial<QueueLag> {
  ok: boolean;
  db: 'ok' | 'down';
  /** Seconds since the last completed pass of each loop; null before the first one. */
  outboxTickAgeSeconds: number | null;
  jobsTickAgeSeconds: number | null;
}

/**
 * Ready when the lag query answered, each loop's last pass is younger than three intervals plus
 * thirty seconds (a long job run still fits), and both lags are below the maximum.
 */
export function assessWorker({
  lag,
  ticks,
  now,
  intervalsMs,
  maxLagSeconds,
}: {
  lag: QueueLag | null;
  ticks: { outbox: number | null; jobs: number | null };
  now: number;
  intervalsMs: { outbox: number; jobs: number };
  maxLagSeconds: number;
}): WorkerReadiness {
  const age = (at: number | null) => (at === null ? null : Math.round((now - at) / 1000));
  const fresh = (at: number | null, intervalMs: number) =>
    at !== null && now - at <= 3 * intervalMs + 30_000;
  const ok =
    lag !== null &&
    fresh(ticks.outbox, intervalsMs.outbox) &&
    fresh(ticks.jobs, intervalsMs.jobs) &&
    lag.outboxLagSeconds < maxLagSeconds &&
    lag.jobsLagSeconds < maxLagSeconds;
  return {
    ok,
    db: lag === null ? 'down' : 'ok',
    outboxTickAgeSeconds: age(ticks.outbox),
    jobsTickAgeSeconds: age(ticks.jobs),
    ...lag,
  };
}

/** `/healthz`, `/readyz` and `/metrics` on `port`; everything else is a 404. */
export function startWorkerHealth(
  port: number,
  { readiness, metrics }: { readiness: () => Promise<WorkerReadiness>; metrics: Metrics },
  onListening?: () => void
): Server {
  return createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return json(404, { ok: false });
    if (req.url === '/healthz') return json(200, { ok: true });
    if (req.url === '/readyz' || req.url === '/metrics')
      return void readiness().then(
        (r) => {
          if (req.url === '/readyz') return json(r.ok ? 200 : 503, r);
          res.writeHead(200, { 'content-type': METRICS_CONTENT_TYPE });
          res.end(metrics.render());
        },
        () => json(503, { ok: false, db: 'down' })
      );
    json(404, { ok: false });
  }).listen(port, onListening);
}
