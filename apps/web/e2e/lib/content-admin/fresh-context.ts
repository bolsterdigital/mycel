// A second browser for the content-admin tests that need another person beside the test's own
// page: a reader, a stranger without a membership or a stale tab. Same origin, headers and
// JavaScript setting as the project, with its own forwarded address so rate limits never couple
// the two. Here, apart from the spec, because that spec is at its byte limit. Rejected:
// `browser.newContext()` at each call site, which lets the settings drift apart.

import type { Browser, Page } from '@playwright/test';
import { login } from '../login';
import { isA11y } from '../project';

/** A random address in TEST-NET-2, one per context. */
const address = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

/** Another browser, as the test's own: same origin, headers and JavaScript setting. */
export const freshContext = (
  browser: Browser,
  locale = 'nl-NL',
  viewport?: { width: number; height: number }
) =>
  browser.newContext({
    locale,
    ...(viewport ? { viewport } : {}),
    javaScriptEnabled: isA11y(),
    baseURL: 'http://127.0.0.1:4173',
    extraHTTPHeaders: { 'x-forwarded-proto': 'http', 'x-forwarded-for': address() },
  });

/** `fn` on a page signed in as someone with no membership of probe; the context closes after. */
export async function stranger(browser: Browser, fn: (page: Page) => Promise<void>) {
  const context = await freshContext(browser);
  const page = await context.newPage();
  await login(page, '/admin', 'nobody@probe.test');
  await fn(page);
  await context.close();
}
