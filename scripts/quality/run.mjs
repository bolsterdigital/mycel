#!/usr/bin/env node
// Lighthouse is a replaceable Apache-2.0 development tool (ADR 008), never a runtime import.
// Direct 13.5.0 replaces LHCI with explicit approval: LHCI's extra dependency tree had high
// advisories, and our median/identity rules already require a separate evaluator. No public upload.
// Run through scripts/e2e/e2e.mjs --quality: it owns seed, database lock, IdP, API and worker.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, cpus, platform, release } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import lighthouse, { desktopConfig as desktop } from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { IdentityGatherer, IdentityAudit } from './gatherer.mjs';
import { validateIdentity, writerExpectation } from './identity.mjs';
import { compareBaseline } from './baseline.mjs';
import { protectReports } from './protect.mjs';
import { evaluateCell, repairProposals } from './evaluate.mjs';
import { publicNames } from './matrix.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? fallback;
const origin = 'https://localhost:4443';
const route = option('route');
const corpusPath = 'apps/web/e2e/quality-corpus.json';
const corpus = JSON.parse(readFileSync(corpusPath));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (
  execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    encoding: 'utf8',
  }).trim()
)
  throw new Error('Commit the measured tree first: dirty source cannot prove an exact SHA');
const fixtureHash = createHash('sha256')
  .update(readFileSync(corpusPath))
  .update(readFileSync('scripts/e2e/e2e.mjs'))
  .digest('hex');
const scope = option('scope', 'default');
const profile = option('profile', 'mobile');
const locale = option('locale', 'nl');
const cache = option('cache', 'fresh');
if (
  !['default', 'full', 'admin', 'demo'].includes(scope) ||
  !['mobile', 'desktop'].includes(profile) ||
  !['nl', 'en'].includes(locale) ||
  !['fresh', 'warm', 'cold'].includes(cache)
)
  throw new Error('Unsupported scope/profile/locale/cache');
const started = Date.now();
const out = resolve(option('out', `.scratch/quality/${commit}-${Date.now()}`));
if (existsSync(out)) throw new Error('Output directory exists; reports must never be overwritten');
mkdirSync(out, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(tmpdir(), 'mycel-quality-'));
const children = [];
const result = {
  schemaVersion: 1,
  commit,
  fixtureHash,
  fixtureVersion: corpus.fixtureVersion,
  fixtureFiles: [corpusPath, 'scripts/e2e/e2e.mjs'],
  startedAt: new Date(started).toISOString(),
  workflow: process.env.GITHUB_ACTIONS
    ? { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT }
    : null,
  environment: {
    node: process.version,
    lighthouse: require('lighthouse/package.json').version,
    playwright: require('@playwright/test/package.json').version,
    runner: process.env.GITHUB_ACTIONS
      ? `github-container:${process.env.QUALITY_RUNNER_IMAGE?.split('@')[1]}`
      : `local:${platform()}:${release()}`,
    ...(process.env.GITHUB_ACTIONS
      ? { hostImage: process.env.QUALITY_HOST_IMAGE, kernel: release() }
      : {}),
    mode: process.env.GITHUB_ACTIONS ? 'ci' : 'local',
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    caddy: execFileSync('caddy', ['version'], { encoding: 'utf8' }).trim(),
    profile,
    locale,
    cache,
    scope,
    theme: 'seeded-default',
    warmup: cache === 'warm' ? 'one unmeasured navigation per fresh browser' : 'none',
    serverCache:
      cache === 'cold'
        ? 'new web process per sample; database/proxy remain warm'
        : 'shared web process',
  },
  cells: [],
  coverage: [
    {
      state: 'not-measured',
      route: 'dynamic POST/iframe preview',
      reason: 'requires a versioned dynamic-state measurement contract; GET is an empty shell',
    },
    {
      state: 'not-measured',
      route: 'demanding tenant theme',
      reason: `${corpus.fixtureVersion} theme is simulated, not a persisted tenant fixture`,
    },
    ...corpus.planned
      .filter((p) => p.route !== 'site-chrome')
      .map((p) => ({ ...p, state: 'not-measured' })),
    {
      state: 'not-measured',
      route: 'manual accessibility and field data',
      reason:
        'see release scenarios in frontend-quality.md; no real-user data or screen reader available',
    },
  ],
};
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2));
const launch = (command, argv, env) => {
  const child = spawn(command, argv, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(child);
  return child;
};
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  rmSync(scratch, { recursive: true, force: true });
};
process.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    save('summary.json', { ...result, interrupted: true });
    process.exit(1);
  });
async function ready(url, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${url}`);
    if (
      await fetch(url)
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Readiness deadline: ${url}`);
}
save('summary.json', { ...result, state: 'not-measured' });
let browser;
try {
  const { DATABASE_URL: _owner, ...frontEnv } = process.env;
  const startWeb = () =>
    launch('node', ['apps/web/build/index.js'], {
      ...frontEnv,
      HOST: '127.0.0.1',
      PORT: '4173',
      PUBLIC_BASE_URL: origin,
      ADDRESS_HEADER: 'x-forwarded-for',
      PROTOCOL_HEADER: 'x-forwarded-proto',
      BODY_SIZE_LIMIT: '26M',
    });
  let web = startWeb();
  await ready('http://127.0.0.1:4173/healthz', web);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${scratch}/key.pem`,
      '-out',
      `${scratch}/cert.pem`,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' }
  );
  const certificate = new X509Certificate(readFileSync(`${scratch}/cert.pem`));
  const spki = createHash('sha256')
    .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  // The production encode/routing directives are mirrored by a conformance test. Only TLS
  // provisioning and the fixed local upstream differ; security/cache headers remain the app's.
  writeFileSync(
    `${scratch}/Caddyfile`,
    `{
    admin off
    auto_https disable_redirects
  }
  https://localhost:4443 {
    bind 127.0.0.1
    tls ${scratch}/cert.pem ${scratch}/key.pem
    encode zstd gzip
    @internal path /internal/* /readyz /metrics
    respond @internal 404
    reverse_proxy 127.0.0.1:4173
  }`
  );
  launch('caddy', ['run', '--config', `${scratch}/Caddyfile`, '--adapter', 'caddyfile'], {
    ...process.env,
    XDG_CONFIG_HOME: scratch,
    XDG_DATA_HOME: scratch,
  });
  browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  result.environment.chromium = browser.version();
  const context = await browser.newContext();
  const page = await context.newPage();
  // Browser readiness also verifies that the exact ephemeral certificate is trusted. No global
  // certificate bypass, and no ignoring failed application/asset requests.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(`${origin}/healthz`);
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const names = publicNames(corpus, scope);
  const entries = Object.entries(corpus.public)
    .filter(([name]) => names.includes(name) && (!route || name === route))
    .map(([name, entry]) => ({
      id: `${name}-${locale}-${profile}-${cache}`,
      name,
      url: origin + entry.locales[locale].path,
      locale,
      title: entry.locales[locale].title,
      indexable: true,
      canonicalSuffix: `${locale === 'en' ? '/en' : ''}/${entry.routeClass === 'article' ? 'articles/' : ''}${entry.slug}`,
      ...entry.expected,
      article: entry.routeClass === 'article',
    }));
  let cookie;
  if (scope === 'full' || scope === 'admin') {
    const list = await fetch(`${process.env.E2E_API_URL}/v1/content.item.list`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.MYCEL_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'article', slug: corpus.public.article.slug }),
    });
    if (!list.ok) throw new Error('Cannot resolve corpus article');
    const { items } = await list.json();
    if (items.length !== 1) throw new Error('Ambiguous corpus article');
    const detail = await fetch(`${process.env.E2E_API_URL}/v1/content.item.get`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.MYCEL_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ itemId: items[0].id }),
    });
    if (!detail.ok) throw new Error('Cannot resolve corpus revision');
    const { revision } = await detail.json();
    // The corpus writer URL has no locale query: its body uses Probe's default locale (nl),
    // independently of the admin chrome's Accept-Language. Do not invent an English body.
    const writerBlocks = writerExpectation(revision.document, 'nl');
    if (!writerBlocks.some((block) => block.type === 'rich-text' && block.text))
      throw new Error('Corpus revision has no representative prose');
    await page.goto(`${origin}/admin/probe/content`);
    await page.locator('main a[href*="start=1"]').click();
    await page.getByLabel('E-mail').fill('e2e-admin@probe.test');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${origin}/admin/probe/content`);
    cookie = (await context.cookies()).find((c) => c.name === 'mycel_session');
    if (!cookie) throw new Error('Mock login did not issue a session');
    for (const entry of corpus.admin.routes)
      entries.push({
        id: `${entry.name}-${locale}-${profile}-${cache}`,
        name: entry.name,
        url: origin + entry.path.replace('{quality-article-id}', items[0].id),
        locale,
        indexable: false,
        title: '',
        populated: entry.name === 'populated-list',
        writer: entry.name === 'enhanced-writer',
        ...(entry.name === 'enhanced-writer' ? { writerBlocks } : {}),
        item: entry.name !== 'populated-list',
      });
  } else
    result.coverage.push({
      state: 'not-measured',
      route: 'admin corpus',
      reason: `${scope} set is public; use --scope=full locally`,
    });
  await context.close();
  for (const entry of entries.filter((e) => scope !== 'admin' || !e.indexable)) {
    const provenance = { commit, fixtureHash, ...result.environment };
    const contract = { ...entry, provenance };
    const batches = [];
    const batchCount = args.includes('--diagnostic') ? 2 : 1;
    for (let batch = 0; batch < batchCount; batch++) {
      if (batch && !['inconclusive', 'fail'].includes(evaluateCell(contract, batches).state)) break;
      if (
        batch &&
        evaluateCell(contract, batches).batches[0].reasons.some(
          (r) => r !== 'performance' && r !== 'unstable-performance'
        )
      )
        break;
      const samples = [];
      for (let i = 0; i < 5; i++) {
        const id = `${entry.id}-b${batch + 1}-${i + 1}`;
        const sample = { id, provenance };
        const dir = join(out, entry.indexable ? 'public' : 'private', id);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        let chrome;
        try {
          if (cache === 'cold') {
            await new Promise((resolve) => {
              web.once('exit', resolve);
              web.kill('SIGTERM');
            });
            web = startWeb();
            await ready('http://127.0.0.1:4173/healthz', web);
          }
          chrome = await chromeLauncher.launch({
            chromePath: chromium.executablePath(),
            chromeFlags: [
              '--headless',
              '--no-sandbox',
              `--ignore-certificate-errors-spki-list=${spki}`,
            ],
            logLevel: 'error',
          });
          const browserInfo = await fetch(`http://127.0.0.1:${chrome.port}/json/version`).then(
            (r) => r.json()
          );
          sample.browserVersion = browserInfo.Browser;
          if (browserInfo.Browser?.split('/').at(-1) !== result.environment.chromium)
            throw new Error('Measured Chromium version differs from the declared browser');
          const headers = { 'Accept-Language': locale };
          const config = {
            ...(profile === 'desktop' ? desktop : { extends: 'lighthouse:default' }),
            artifacts: [
              {
                id: 'MycelIdentity',
                gatherer: new IdentityGatherer(entry.indexable ? undefined : cookie),
              },
            ],
            audits: [IdentityAudit],
          };
          const flags = {
            port: chrome.port,
            output: ['json', 'html'],
            logLevel: 'error',
            enableErrorReporting: false,
            onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
            onlyAudits: ['mycel-identity'],
            extraHeaders: headers,
            disableStorageReset: cache === 'warm',
          };
          // Each warm-cache sample has its own browser and one declared unmeasured navigation.
          if (cache === 'warm') await lighthouse(entry.url, flags, config);
          const measured = await lighthouse(entry.url, flags, config);
          sample.report = measured.lhr;
          sample.measurementSettings = measured.lhr.configSettings;
          writeFileSync(join(dir, 'lighthouse.json'), measured.report[0]);
          writeFileSync(join(dir, 'lighthouse.html'), measured.report[1]);
          const logs = measured.artifacts.DevtoolsLog;
          const responses = logs
            .filter((e) => e.method === 'Network.responseReceived')
            .map((e) => e.params);
          const document = responses.filter((e) => e.type === 'Document').at(-1)?.response;
          const responseHeaders = Object.fromEntries(
            Object.entries(document?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
          );
          const requests = logs
            .filter((e) => e.method === 'Network.requestWillBeSent')
            .map((e) => e.params.request.url);
          const failedRequests = logs
            .filter((e) => e.method === 'Network.loadingFailed' && !e.params.canceled)
            .map((e) => e.params.errorText);
          const facts = {
            ...measured.artifacts.MycelIdentity,
            status: document?.status,
            csp: responseHeaders['content-security-policy'],
            privateCache: /private/.test(responseHeaders['cache-control'] ?? ''),
            requests,
            failedRequests: [
              ...failedRequests,
              ...responses.filter((e) => e.response.status >= 400).map((e) => e.response.url),
            ],
            foreignRequests: requests.filter(
              (url) => /^https?:/.test(url) && new URL(url).origin !== origin
            ),
            pageErrors: (measured.artifacts.ConsoleMessages ?? [])
              .filter((m) => m.source === 'exception')
              .map((m) => m.text),
          };
          // Validate every declared image, including below-fold lazy images. Outside the timed
          // window, using URLs from this exact measured document and the same HTTPS origin.
          for (const url of facts.imageUrls ?? []) {
            const response = await pageRequest(url, headers);
            if (!response) facts.failedRequests.push(url);
          }
          sample.identity = validateIdentity(entry, facts);
          sample.facts = facts;
          writeFileSync(join(dir, 'trace.json'), JSON.stringify(measured.artifacts.Trace));
          // Full devtools logs contain credentials; persist a network summary instead.
          writeFileSync(
            join(dir, 'network.json'),
            JSON.stringify(
              { requests, failedRequests: facts.failedRequests, headers: responseHeaders },
              null,
              2
            )
          );
        } catch (error) {
          sample.error = error.message;
        } finally {
          await chrome?.kill();
        }
        samples.push(sample);
        result.activeCell = { id: entry.id, samples: samples.length, expected: 5 };
        save('summary.json', { ...result, state: 'inconclusive' });
        // Never persist cookies/extraHeaders in a summary; Lighthouse raw admin reports stay
        // in private/ and CI uploads only public/ plus this sanitized summary.
        const { report: _report, ...metadata } = sample;
        writeFileSync(join(dir, 'sample.json'), JSON.stringify(metadata, null, 2));
        console.log(
          `quality: ${id}: ${sample.error ?? JSON.stringify(sample.report?.categories && Object.fromEntries(Object.entries(sample.report.categories).map(([k, v]) => [k, v.score])))}`
        );
      }
      batches.push(samples);
    }
    delete result.activeCell;
    result.cells.push({
      id: entry.id,
      route: entry.url,
      locale,
      state: entry.indexable ? 'published' : entry.name,
      profile,
      cache,
      indexable: entry.indexable,
      ...evaluateCell(contract, batches),
    });
    save('summary.json', result);
  }
} catch (error) {
  result.error = error.message;
} finally {
  await browser?.close();
  result.durationMinutes = (Date.now() - started) / 60000;
  result.repairs = repairProposals(result.cells);
  try {
    protectReports(out);
  } catch (error) {
    result.error = `Private evidence encryption failed: ${error.message}`;
  }
  result.state =
    result.error || !result.cells.length
      ? 'inconclusive'
      : result.cells.some((c) => c.state === 'fail')
        ? 'fail'
        : result.cells.some((c) => c.state !== 'pass')
          ? 'inconclusive'
          : 'pass';
  let previous;
  const baseline = option('baseline');
  if (baseline && existsSync(baseline)) {
    try {
      previous = JSON.parse(readFileSync(baseline, 'utf8'));
    } catch {
      /* Invalid predecessor cannot establish a baseline. */
    }
  }
  result.baselineComparison = compareBaseline(result, previous);
  save('summary.json', result);
  console.log(`quality: ${result.state}; reports ${out}`);
  stop();
}
// Scores never masquerade as success during calibration. CI may tolerate this exit in a named
// observation step, but the report and summary keep the actual fail/inconclusive state.
process.exitCode = result.state === 'pass' ? 0 : 1;

async function pageRequest(url, headers) {
  // Playwright's request API shares the browser's local trust exception for this fixture only.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: headers });
  try {
    if (new URL(url).origin !== origin) return false;
    const response = await ctx.request.get(url);
    return response.ok() && /^image\//.test(response.headers()['content-type'] ?? '');
  } catch {
    return false;
  } finally {
    await ctx.close();
  }
}
