import { inspectMailchimp, createMailchimpRequester } from '../mailchimp/client.js';
import { mailchimpTransport } from '../mailchimp/transport.js';
// Composition root (docs/architecture/overview.md): the one place that turns configuration into
// adapter instances and hands fronts an Invoker. The HTTP server, the MCP server and the web app
// all call `createRuntime`, so no front wires adapters itself and none can wire them differently.
// Rejected: a composition file per front (the overview's first sketch), which the probe showed
// would triplicate config parsing, signer setup and subscriber lists.

import { createHash } from 'node:crypto';
import {
  Invoker,
  appDelivery,
  buildRegistry,
  FORM_MAIL_SUBSCRIBER,
  formMailSource,
  formMailSubscriber,
  CONFIRMATION_SUBSCRIBER,
  confirmationMailSource,
  confirmationMailSubscriber,
  siteUrl,
  supporterIngestSubscriber,
  type BlobStore,
  type Clock,
  SYNTHETIC_SOURCE,
  syntheticSource,
  formFeedSubscriber,
  formFeedSource,
  FORM_FEED_SOURCE,
  type ErrorReporter,
  type IdentityStore,
  type Logger,
  type Mailer,
  type PlatformConfig,
  type SiteAddress,
  type Signer,
  type SiteDirectory,
  type Subscriber,
  type TenantDirectory,
  type TenantStatus,
  type UnitOfWork,
} from '@mycel/core';
import {
  consoleErrorReporter,
  createLogger,
  currentContext,
  logLevelOf,
  Metrics,
  buildVersion,
  recordBuildInfo,
  runWithContext,
  sentryErrorReporter,
} from '@mycel/observability';
import {
  createDb,
  createIdentityStore,
  createSiteDirectory,
  createTenantDirectory,
  createTenant,
  createUnitOfWork,
  getTenant,
  getTenantBySlug,
  listTenants,
  opsCloseJob,
  opsDeadEvents,
  opsJobs,
  opsRetryEvent,
  opsRetryJob,
  opsSummary,
  opsUnresolvedMail,
  ping,
  queueLag,
  setEntitlements,
  setStatus,
  startJobWorker,
  startOutboxWorker,
  uuidv7,
  uuidv7Ids,
  type JobHandlers,
  type NewTenant,
  type OpsPage,
  type PlatformActor,
} from '@mycel/db';
import { ConsoleMailer, TemMailer } from '@mycel/mail-tem';
import { createSharpProcessor, createBrandProcessor } from '@mycel/media-sharp';
import { FakeTextModel } from '@mycel/core/fake-text-model';
import { OpenAITextModel } from '@mycel/assist-openai';
import { createAuthenticator, type Authenticator } from '../auth.js';
import { createDnsResolver } from './dns.js';
import type { HttpObservability } from '../app.js';
import { assessWorker, type WorkerReadiness } from '../health.js';
import type { PlatformDeps } from '../platform.js';
import { JOB_POOLS, RECURRING_JOBS, jobHandlers } from '../jobs.js';
import { HmacSigner } from './signer.js';
import { blobStoreFor } from './blob-store.js';
import { inputHasherOf, loadConfig, platformOf, type RuntimeConfig } from './config.js';
import { webhookTransport } from '../webhook.js';

export { createAuthenticator, type Authenticator, type AuthenticatorDeps } from '../auth.js';
// The configuration and the blob store moved out; callers keep importing them here.
export * from './config.js';
export * from './blob-store.js';

/** `Name <addr@x>` or `addr@x`. */
function parseAddress(value: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  return m && m[1] ? { name: m[1], email: m[2]! } : { email: m?.[2] ?? value.trim() };
}

/** Which process this runtime serves: the `service` field of every log line. */
export interface RuntimeOptions {
  service?: 'api' | 'web' | 'worker' | 'mcp' | 'cli';
  /** One finished log line; default stdout (the MCP server passes stderr). */
  writeLog?: (line: string) => void;
}

/** The worker's series (brief #17a decision 8); never a tenant id as a label. */
function workerMetrics(metrics: Metrics) {
  return {
    lag: {
      outboxLagSeconds: metrics.gauge(
        'mycel_outbox_lag_seconds',
        'Age of the oldest undelivered outbox event'
      ),
      outboxDead: metrics.gauge('mycel_outbox_dead', 'Outbox events that used up their attempts'),
      jobsLagSeconds: metrics.gauge(
        'mycel_jobs_lag_seconds',
        'Wait of the oldest due, claimable job'
      ),
      jobsExhausted: metrics.gauge('mycel_jobs_exhausted', 'Open jobs that used up their attempts'),
    },
    runs: metrics.counter('mycel_jobs_runs_total', 'Job runs by type and result'),
  };
}

/**
 * The platform's tenant and ops operations on one login, each mutation audited as `by()`: the
 * platform API binds them to the authentication login and a token fingerprint, `mycel` to the
 * operator login and `cli` (TODO #74). Each function enters mycel_platform or mycel_ops itself
 * (0010, 0016). Rejected: each front wiring the db functions itself, which is how the two lists
 * drifted apart.
 */
export function platformOperations(
  db: ReturnType<typeof createDb>,
  platform: PlatformConfig,
  by: () => PlatformActor
) {
  return {
    create: (input: Omit<NewTenant, 'id'>) =>
      createTenant(db, { id: uuidv7(), ...input }, platform, by()),
    list: () => listTenants(db),
    get: (id: string) => getTenant(db, id),
    bySlug: (slug: string) => getTenantBySlug(db, slug),
    setEntitlements: (id: string, document: unknown) => setEntitlements(db, id, document, by()),
    setStatus: (id: string, status: TenantStatus) => setStatus(db, id, status, by()),
    // Stuck rows without payloads.
    ops: {
      summary: () => opsSummary(db),
      jobs: (q: OpsPage) => opsJobs(db, q),
      outbox: (q: OpsPage) => opsDeadEvents(db, q),
      mail: (q: OpsPage) => opsUnresolvedMail(db, q),
      retryJob: (id: string) => opsRetryJob(db, id, by()),
      closeJob: (id: string) => opsCloseJob(db, id, by()),
      retryEvent: (id: string) => opsRetryEvent(db, id, by()),
    },
  };
}

/** The audit `actor_id` of a platform token: two tokens differ, the token is not kept. */
export const tokenFingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 8);

const OUTBOX_INTERVAL_MS = 1000;
const JOBS_INTERVAL_MS = 5000;

export interface Runtime {
  config: RuntimeConfig;
  /** The process logger; it adds the request or job context by itself (`runWithContext`). */
  log: Logger;
  /** Console line always, plus the tracker when ERROR_REPORTING_DSN is set. */
  errors: ErrorReporter;
  metrics: Metrics;
  /** What `createApp` needs for request ids, access lines, `/readyz` and `/metrics`. */
  http: HttpObservability;
  /** `select 1` over the application connection within a second (`/readyz` of api and web). */
  ready(): Promise<boolean>;
  /** The worker's `/readyz`: database, fresh loop ticks, queue lag. Needs DATABASE_URL. */
  workerReadiness(): Promise<WorkerReadiness>;
  platform: PlatformConfig;
  invoker: Invoker;
  uow: UnitOfWork;
  tenants: TenantDirectory;
  /** Hostname to site, as mycel_auth, cached (ADR 014). `invalidate` after an admin change. */
  sites: SiteDirectory & { invalidate(hostname?: string): void };
  /** The one builder of absolute site URLs (ADR 014 rule 6), bound to this platform. */
  siteUrl(site: SiteAddress, path?: string): string;
  clock: Clock;
  signer: Signer;
  mailer: Mailer;
  /** Media files (TODO #10); the web front's delivery route reads variants from here. */
  blobs: BlobStore;
  subscribers: Subscriber[];
  /** Authentication-time lookups (operators, memberships, keys) as mycel_auth. */
  identity: IdentityStore;
  /** Principal for a bearer token from `api_keys`, or null when unknown or revoked. */
  authenticateApiKey: Authenticator['authenticateApiKey'];
  /** Principal for an MCP session from MYCEL_API_KEY's row (stdio: whoever holds the env). */
  agentPrincipal: Authenticator['agentPrincipal'];
  /** The platform API's dependencies, or undefined without PLATFORM_API_TOKEN (TODO #16). */
  platformApi: PlatformDeps | undefined;
  /** Start draining the outbox and running due jobs in this process. Needs DATABASE_URL. */
  startWorker(): () => Promise<void>;
  close(): Promise<void>;
}

export function createRuntime(
  config: RuntimeConfig = loadConfig(),
  { service = 'api', writeLog }: RuntimeOptions = {}
): Runtime {
  const clock: Clock = { now: () => new Date() };
  const log = createLogger({ service, level: logLevelOf(config.LOG_LEVEL), write: writeLog });
  const reporters: ErrorReporter[] = [consoleErrorReporter(log)];
  if (config.ERROR_REPORTING_DSN)
    reporters.push(
      sentryErrorReporter({
        dsn: config.ERROR_REPORTING_DSN,
        environment: config.ERROR_REPORTING_ENVIRONMENT ?? config.NODE_ENV,
        service,
        log,
      })
    );
  const errors: ErrorReporter = {
    capture: (error, context) => reporters.forEach((r) => r.capture(error, context)),
  };
  const metrics = new Metrics();
  recordBuildInfo(metrics);
  const signer = new HmacSigner(config.SIGNING_SECRET);
  const inputHasher = inputHasherOf(config);
  const appDb = createDb(config.APP_DATABASE_URL);
  const authDb = createDb(config.AUTH_DATABASE_URL);
  const operatorDb = config.DATABASE_URL ? createDb(config.DATABASE_URL) : null;
  const platform = platformOf(config);
  const blobs = blobStoreFor(config);
  const assistModel =
    config.ASSIST_PROVIDER === 'fake'
      ? new FakeTextModel()
      : config.ASSIST_PROVIDER === 'openai-compatible'
        ? new OpenAITextModel({
            baseUrl: config.ASSIST_BASE_URL!,
            ...(config.ASSIST_API_KEY ? { apiKey: config.ASSIST_API_KEY } : {}),
            label: config.ASSIST_PROVIDER_LABEL!,
            textModel: config.ASSIST_TEXT_MODEL!,
            visionModel: config.ASSIST_VISION_MODEL!,
          })
        : null;
  const assistProviderLabel =
    config.ASSIST_PROVIDER === 'none'
      ? null
      : (config.ASSIST_PROVIDER_LABEL ?? assistModel?.describe().label ?? null);
  const dns = createDnsResolver();
  const mailchimpRequest = createMailchimpRequester(config.MAILCHIMP_FIXTURE_ORIGIN);
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer,
    dns,
    platform,
    media: { blobs, images: createSharpProcessor(), delivery: appDelivery },
    brandProcessor: createBrandProcessor(),
    log,
    inputHasher,
    connectionCredentialKey: config.CONNECTION_CREDENTIAL_KEY,
    assistProviderLabel,
    mailchimpDiscovery: { inspect: (key) => inspectMailchimp(key, mailchimpRequest) },
  });
  const tenants = createTenantDirectory(appDb);
  const identity = createIdentityStore(authDb, uuidv7Ids);
  const sites = createSiteDirectory(authDb);
  const auth = createAuthenticator({
    identity,
    uow,
    clock,
    agentToken: config.MYCEL_API_KEY,
    sessionId: uuidv7(),
    log,
  });
  const invoker = new Invoker(buildRegistry(), uow, {
    requestId: () => currentContext().requestId,
    log,
    errors,
  });
  const mailer: Mailer =
    config.MAILER === 'tem'
      ? new TemMailer({
          secretKey: config.TEM_SECRET_KEY ?? '',
          projectId: config.TEM_PROJECT_ID ?? '',
          region: config.TEM_REGION,
        })
      : new ConsoleMailer(
          // Form templates may contain free text: retain only delivery metadata in logs.
          () => log.info('console mailer accepted'),
          config.MAIL_SPOOL_DIR
        );
  const confirmation = {
    mailer,
    signer,
    clock,
    tenants,
    uow,
    from: parseAddress(config.MAIL_FROM),
    platform,
    access: (id: string) => identity.tenantAccess(id),
    reconcileLagMs: config.MAIL_RECONCILE_LAG_MINUTES * 60 * 1000,
  };
  const formMail = { ...confirmation, access: (id: string) => identity.tenantAccess(id) };
  const subscribers = [
    supporterIngestSubscriber(uow),
    confirmationMailSubscriber(confirmation),
    formMailSubscriber(formMail),
    formFeedSubscriber(uow),
  ];
  // What `mail.reconcile` rebuilds a message with, per mail subscriber above.
  const mailSources = {
    [CONFIRMATION_SUBSCRIBER]: confirmationMailSource(confirmation),
    [FORM_MAIL_SUBSCRIBER]: formMailSource(formMail),
  };
  const stops: (() => Promise<void>)[] = [];
  // On the authentication login: each platform function enters mycel_platform itself (0010).
  // Each mutation writes its audit row with the token's fingerprint, never the token (#17b).
  const platformToken = config.PLATFORM_API_TOKEN;
  const by = () => ({
    actorId: tokenFingerprint(platformToken ?? ''),
    hasher: inputHasher,
    requestId: currentContext().requestId,
  });
  const platformApi: PlatformDeps | undefined = platformToken
    ? { token: platformToken, store: platformOperations(authDb, platform, by) }
    : undefined;

  const ready = () => ping(appDb);
  const ticks: { outbox: number | null; jobs: number | null } = { outbox: null, jobs: null };
  // Defined on first use, so an api process without the worker exposes no empty worker series.
  let workerSeries: ReturnType<typeof workerMetrics> | undefined;
  const series = () => (workerSeries ??= workerMetrics(metrics));
  /** Every job and outbox delivery runs in its own log context. */
  const inJobContext = (handlers: JobHandlers): JobHandlers =>
    Object.fromEntries(
      Object.entries(handlers).map(([type, handler]) => [
        type,
        (job: Parameters<typeof handler>[0]) =>
          runWithContext({ job: type, ...(job.tenantId ? { tenantId: job.tenantId } : {}) }, () =>
            handler(job)
          ),
      ])
    );
  const inEventContext = (sub: Subscriber): Subscriber => ({
    ...sub,
    handle: (event) =>
      runWithContext({ eventId: event.id, tenantId: event.tenantId }, () => sub.handle(event)),
  });

  return {
    config,
    log,
    errors,
    metrics,
    http: {
      log,
      errors,
      metrics,
      newRequestId: () => uuidv7(),
      ready,
      metricsToken: config.METRICS_TOKEN,
    },
    ready,
    async workerReadiness() {
      if (!operatorDb) throw new Error('the worker needs DATABASE_URL (operator role)');
      const lag = await queueLag(operatorDb).catch(() => null);
      if (lag)
        for (const [name, gauge] of Object.entries(series().lag))
          gauge.set(lag[name as keyof typeof lag]);
      return assessWorker({
        lag,
        ticks,
        now: Date.now(),
        intervalsMs: { outbox: OUTBOX_INTERVAL_MS, jobs: JOBS_INTERVAL_MS },
        maxLagSeconds: config.READY_MAX_LAG_SECONDS,
      });
    },
    platform,
    invoker,
    uow,
    tenants,
    sites,
    siteUrl: (site, path) => siteUrl(site, platform, path),
    clock,
    signer,
    mailer,
    blobs,
    subscribers,
    identity,
    authenticateApiKey: auth.authenticateApiKey,
    agentPrincipal: auth.agentPrincipal,
    platformApi,
    startWorker() {
      if (!operatorDb) throw new Error('the worker needs DATABASE_URL (operator role)');
      const stopOutbox = startOutboxWorker(operatorDb, subscribers.map(inEventContext), {
        intervalMs: OUTBOX_INTERVAL_MS,
        log,
        onError: errors.capture,
        onTick: () => void (ticks.outbox = Date.now()),
      });
      const mail = {
        mailer,
        clock,
        sources: mailSources,
        reconcileLagMs: confirmation.reconcileLagMs,
      };
      const webhook = webhookTransport({ dns });
      const mailchimp = mailchimpTransport({ uow, identity, clock, request: mailchimpRequest });
      const handlers = jobHandlers({
        uow,
        operatorDb,
        identity,
        mail,
        retentionDays: config.JOBS_RETENTION_DAYS,
        auditRetentionDays: config.AUDIT_RETENTION_DAYS,
        errors,
        assist: {
          model: assistModel,
          timeoutMs: config.ASSIST_TIMEOUT_MS,
          retentionDays: config.ASSIST_RETENTION_DAYS,
          clock,
        },
        exports: {
          blobs,
          mycelVersion: buildVersion(),
          retentionDays: config.EXPORT_RETENTION_DAYS,
          log,
        },
        connections: {
          transport: {
            dispatch: (input) =>
              input.connection.provider === 'mailchimp'
                ? mailchimp.dispatch(input)
                : webhook.dispatch(input),
            reconcile: (input) =>
              input.connection.provider === 'mailchimp'
                ? mailchimp.reconcile!(input)
                : Promise.resolve('unknown'),
          },
          mailchimpSync: mailchimp.sync,
          sources: { [SYNTHETIC_SOURCE]: syntheticSource, [FORM_FEED_SOURCE]: formFeedSource },
        },
      });
      const stopJobs = startJobWorker(operatorDb, inJobContext(handlers), {
        intervalMs: JOBS_INTERVAL_MS,
        recurring: RECURRING_JOBS,
        pools: JOB_POOLS,
        log,
        onError: errors.capture,
        onTick: () => void (ticks.jobs = Date.now()),
        onRun: (job, result) => series().runs.inc({ type: job.type, result }),
      });
      const stop = async () => {
        await Promise.all([stopOutbox(), stopJobs()]);
      };
      stops.push(stop);
      return stop;
    },
    async close() {
      await Promise.all(stops.map((s) => s()));
      await appDb.destroy();
      await authDb.destroy();
      await operatorDb?.destroy();
    },
  };
}
