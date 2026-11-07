// A browser test that waits for a screen to report ready and never sees it fail with one line:
// the aria snapshot shows the whole document, yet nothing says whether its script loaded late,
// ran late or threw before it set the mark. This fixture keeps, per page of the test's context,
// the page errors, console errors and warnings, failed requests, and the timing of every
// navigation and script (the admin's own under `/_admin/`, SvelteKit's chunks under `/_app/`,
// which hydrate the page before `onMount` imports the admin's), and writes them to `page-evidence.json` in the test's output
// folder when the test fails. A passing test attaches nothing.
// Rejected: a longer timeout or a retry (they hide the cause), tracing every test (heavy, and
// the trace was missing in the artifact of the run that needed it), and listeners in
// `editorReady` alone (many specs wait for the mark themselves, and a listener added there misses
// what happened before the call).
// A page can stop answering altogether (it then also ignores `evaluate`), so every question asked
// after the test is bounded, and the file also says whether the browser and a fresh page in the
// same context still answer: that tells a hung page from a hung browser or connection.

import { writeFileSync } from 'node:fs';
import { test as base, type Page, type Request } from '@playwright/test';

/** What one page recorded; `ms` counts from the start of the test. */
type Entry = { ms: number; page: number; event: string } & Record<string, unknown>;

/** Enough for one long failing test; older entries go first. */
const KEEP = 2000;

/** Scripts of the app; styles, images and fonts say nothing about a ready mark. */
const SCRIPT = /\/_(admin|app)\/[^?]+\.js(\?|$)/;

/** Navigations and scripts; the rest of the network says nothing here. */
const watched = (request: Request) => request.isNavigationRequest() || SCRIPT.test(request.url());

/** How long one question after the test may take; a hung page otherwise costs a second timeout. */
const ASK_MS = 2000;

/** The answer, or `{ noAnswerMs }` when none came in time; an error is an answer too. */
const ask = async <T>(question: () => Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<{ noAnswerMs: number }>((resolve) => {
    timer = setTimeout(() => resolve({ noAnswerMs: ASK_MS }), ASK_MS);
  });
  try {
    return await Promise.race([
      question().then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error: String(error) })
      ),
      silence,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Path only: query strings in a login hop carry transient credentials. */
const path = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};

export const test = base.extend<{ pageEvidence: void }>({
  pageEvidence: [
    async ({ context }, use, info) => {
      const started = Date.now();
      const entries: Entry[] = [];
      const pages: Page[] = [];
      const record = (page: Page, event: string, detail: Record<string, unknown> = {}) => {
        entries.push({ ms: Date.now() - started, page: pages.indexOf(page), event, ...detail });
        if (entries.length > KEEP) entries.shift();
      };
      const watch = (page: Page) => {
        pages.push(page);
        page.on('pageerror', (error) =>
          record(page, 'pageerror', { message: error.message, stack: error.stack })
        );
        page.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning')
            record(page, `console.${message.type()}`, { text: message.text() });
        });
        page.on('request', (request) => {
          if (watched(request))
            record(page, 'request', { method: request.method(), url: path(request.url()) });
        });
        page.on('requestfinished', (request) => {
          if (!watched(request)) return;
          // Milliseconds from the request's start; -1 where the browser did not measure.
          const { requestStart, responseStart, responseEnd } = request.timing();
          record(page, 'finished', {
            url: path(request.url()),
            requestStart,
            responseStart,
            responseEnd,
          });
        });
        page.on('requestfailed', (request) => {
          if (watched(request))
            record(page, 'requestfailed', {
              url: path(request.url()),
              failure: request.failure()?.errorText,
            });
        });
        page.on('domcontentloaded', () =>
          record(page, 'domcontentloaded', { url: path(page.url()) })
        );
        page.on('load', () => record(page, 'load', { url: path(page.url()) }));
      };
      context.pages().forEach(watch);
      context.on('page', watch);
      await use();
      if (info.status === info.expectedStatus) return;
      // Where each open page stands now, from the page itself: its scripts as the browser saw
      // them, and which ready marks are set.
      const now = await Promise.all(
        [...pages].map(async (page, index) => {
          if (page.isClosed()) return { page: index, closed: true };
          return {
            page: index,
            url: path(page.url()),
            ...(await ask(() =>
              page.evaluate(
                (pattern) => ({
                  readyState: document.readyState,
                  editScreen: document
                    .querySelector('form#item-edit')
                    ?.hasAttribute('data-edit-screen'),
                  scripts: [...document.scripts].map((script) => ({
                    src: script.src ? new URL(script.src).pathname : '(inline)',
                    type: script.type,
                    async: script.async,
                    defer: script.defer,
                  })),
                  resources: performance
                    .getEntriesByType('resource')
                    .filter((entry) => new RegExp(pattern).test(entry.name))
                    .map((entry) => ({
                      name: new URL(entry.name).pathname,
                      startTime: Math.round(entry.startTime),
                      responseEnd: Math.round((entry as PerformanceResourceTiming).responseEnd),
                    })),
                  sinceNavigation: Math.round(performance.now()),
                }),
                SCRIPT.source
              )
            )),
          };
        })
      );
      // Does anything above the page still answer? The browser over its own CDP session, and a
      // fresh page in this context (opened after `now`, so it is not one of the test's pages).
      const browser = context.browser();
      const above = {
        browser: browser
          ? await ask(async () => {
              const session = await browser.newBrowserCDPSession();
              const { product } = await session.send('Browser.getVersion');
              await session.detach();
              return product;
            })
          : { error: 'no browser' },
        freshPage: await ask(async () => {
          const fresh = await context.newPage();
          const answer = await fresh.evaluate(() => document.readyState);
          await fresh.close();
          return answer;
        }),
      };
      // A file in the output folder, which CI uploads; a `body` only reaches the reporter.
      const file = info.outputPath('page-evidence.json');
      writeFileSync(file, JSON.stringify({ entries, now, above }, null, 2));
      await info.attach('page-evidence.json', { path: file, contentType: 'application/json' });
    },
    { auto: true },
  ],
});
