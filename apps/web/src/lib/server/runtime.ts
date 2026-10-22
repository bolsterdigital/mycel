// The web front gets its adapters from the shared composition root, like the API and MCP do.
// Kept on globalThis so Vite's dev-mode module reloading does not open a new pool per edit, and
// so the universal `reroute` hook can reach the site directory without importing this module
// (see lib/runtime-key.ts). `init` in hooks.server.ts creates it before the first request.

import { createRuntime, type Runtime } from '@mycel/api/compose';
import { RUNTIME_KEY } from '#lib/runtime-key.js';

type WithRuntime = typeof globalThis & { [RUNTIME_KEY]?: Runtime };

export function runtime(): Runtime {
  const g = globalThis as WithRuntime;
  return (g[RUNTIME_KEY] ??= createRuntime(undefined, { service: 'web' }));
}
