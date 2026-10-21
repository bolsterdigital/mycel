// The web front gets its adapters from the shared composition root, like the API and MCP do.
// Kept on globalThis so Vite's dev-mode module reloading does not open a new pool per edit.

import { createRuntime, type Runtime } from '@mycel/api/compose';

const KEY = Symbol.for('mycel.runtime');
type WithRuntime = typeof globalThis & { [KEY]?: Runtime };

export function runtime(): Runtime {
  const g = globalThis as WithRuntime;
  return (g[KEY] ??= createRuntime());
}
