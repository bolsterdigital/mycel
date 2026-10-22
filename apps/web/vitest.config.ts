// The web workspace's tests (TODO #8c1): plain modules plus the block conformance, which renders
// Svelte components with `svelte/server`. Only the Svelte compiler is needed, not SvelteKit, so
// no `$app` or `$env` module may be imported by a component under test. Runes are forced, as in
// vite.config.ts.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte({ configFile: false, compilerOptions: { runes: true } })],
  test: { name: 'web', include: ['src/**/*.test.ts'] },
});
