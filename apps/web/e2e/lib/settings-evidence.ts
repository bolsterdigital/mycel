// The two-tab settings flow has timed out with identical final screenshots. Keep tab identity
// and the unfinished action alongside its scoped Playwright trace; a screenshot alone cannot
// tell which tab navigated. Rejected: tracing every browser test or guessing a readiness wait.
import { appendFileSync } from 'node:fs';
import { test, type Page, type TestInfo } from '@playwright/test';

export function settingsEvidence(info: TestInfo) {
  const path = info.outputPath('settings-timeline.jsonl');
  const started = Date.now();
  const pages = new Map<string, Page>();
  // Login URLs contain transient credentials. Only settings URLs need their query preserved.
  const url = (value: string) => {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return value;
    return parsed.pathname.endsWith('/site') ? value : `${parsed.origin}${parsed.pathname}`;
  };
  const record = (event: string, detail: Record<string, unknown> = {}) => {
    appendFileSync(
      path,
      `${JSON.stringify({
        ms: Date.now() - started,
        event,
        ...detail,
        tabs: [...pages].map(([tab, page]) => ({
          tab,
          url: url(page.url()),
          closed: page.isClosed(),
        })),
      })}\n`
    );
  };
  return {
    watch(tab: 'A' | 'B', page: Page) {
      pages.set(tab, page);
      record('tab', { tab });
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) record('navigation', { tab });
      });
      page.on('close', () => record('close', { tab }));
      page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame())
          record('request', { tab, method: request.method(), url: url(request.url()) });
      });
      page.on('response', (response) => {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame())
          record('response', { tab, status: response.status(), url: url(response.url()) });
      });
      page.on('requestfailed', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame())
          record('requestfailed', { tab, url: url(request.url()), failure: request.failure() });
      });
    },
    async step<T>(action: string, run: () => Promise<T>): Promise<T> {
      record('start', { action });
      try {
        const result = await test.step(action, run);
        record('complete', { action });
        return result;
      } catch (error) {
        record('failed', { action });
        throw error;
      }
    },
    async attach() {
      record('finish');
      await info.attach('settings-timeline', { path, contentType: 'application/x-ndjson' });
    },
  };
}
