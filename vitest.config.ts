import { defineConfig } from 'vitest/config';

// One Vitest config at the root: core tests run against in-memory ports (ADR 001), adapter
// tests run only when their infrastructure is present (DATABASE_URL etc.) and skip otherwise.
// apps/web is its own project because its block conformance renders Svelte components, which
// needs the Svelte plugin that lives in that workspace (TODO #8c1). Rejected: importing the
// plugin here from apps/web's node_modules, which ties the root to one workspace's layout.
// The global setup refuses a local database that a newer branch migrated (TODO #27).
export default defineConfig({
  test: {
    globalSetup: ['scripts/test-db-preflight.mjs'],
    projects: [
      { extends: true, test: { name: 'packages', include: ['packages/*/src/**/*.test.ts'] } },
      'apps/web/vitest.config.ts',
    ],
  },
});
