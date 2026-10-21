import { defineConfig } from 'vitest/config';

// One Vitest config at the root: core tests run against in-memory ports (ADR 001), adapter
// tests run only when their infrastructure is present (DATABASE_URL etc.) and skip otherwise.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
  },
});
