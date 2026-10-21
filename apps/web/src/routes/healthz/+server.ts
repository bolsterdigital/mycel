// Liveness probe for the container healthcheck (Dockerfile). It deliberately touches no adapter,
// so a slow database does not get the web process restarted. Rejected: a check that queries
// Postgres, which is readiness and belongs to the orchestrator's dependency checks.
import { json } from '@sveltejs/kit';

export const GET = () => json({ ok: true });
