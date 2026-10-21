// End-to-end gate for public pages (ADR 009 rule 3): Playwright drives the production build with
// JavaScript disabled, and axe must report zero violations (WCAG 2.2 AA rule set). Run via `npm run test:e2e` at the
// root, which migrates and seeds first and skips cleanly when no database is configured.
// Rejected: running against `vite dev`, which serves different markup and assets than production.

import { defineConfig } from '@playwright/test';

const port = 4173;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: origin },
  // The same flows run twice. `no-js` proves the product promise (everything works with
  // JavaScript disabled); `a11y` runs axe, which has to inject a script to analyse the page.
  // The pages themselves ship no script (asserted), so both projects see identical documents.
  projects: [
    { name: 'no-js', use: { javaScriptEnabled: false } },
    { name: 'a11y', use: { javaScriptEnabled: true } },
  ],
  webServer: {
    command: 'node build/index.js',
    url: `${origin}/probe/signup`,
    reuseExistingServer: false,
    env: {
      ...(process.env as Record<string, string>),
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_BASE_URL: origin,
      // Behind Caddy the client address comes from this header; tests use it to get a fresh
      // rate-limit bucket per run instead of tripping the per-IP limit on reruns.
      ADDRESS_HEADER: 'x-forwarded-for',
      // adapter-node 6 derives the origin (for the CSRF check on form posts) from this header and
      // defaults to https; behind Caddy it is set by the proxy, here by the tests.
      PROTOCOL_HEADER: 'x-forwarded-proto',
    },
  },
});
