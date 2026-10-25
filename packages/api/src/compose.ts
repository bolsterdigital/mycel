// Composition root (docs/architecture/overview.md): the one place that turns configuration into
// adapter instances and hands fronts an Invoker. The HTTP server, the MCP server and the web app
// all call `createRuntime`, so no front wires adapters itself and none can wire them differently.
// Rejected: a composition file per front (the overview's first sketch), which the probe showed
// would triplicate config parsing, signer setup and subscriber lists.

import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  Invoker,
  appDelivery,
  buildRegistry,
  CONFIRMATION_SUBSCRIBER,
  confirmationMailSource,
  confirmationMailSubscriber,
  normalizeHostname,
  siteUrl,
  supporterIngestSubscriber,
  type BlobStore,
  type Clock,
  type ConnectionSource,
  type ErrorReporter,
  type IdentityStore,
  type Logger,
  type Mailer,
  type PlatformConfig,
  type Principal,
  type SiteAddress,
  type SiteDirectory,
  type Subscriber,
  type TenantDirectory,
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
} from '@mycel/db';
import { createFsBlobStore, createS3BlobStore, type S3BlobStoreConfig } from '@mycel/blob';
import { ConsoleMailer, TemMailer } from '@mycel/mail-tem';
import { createSharpProcessor } from '@mycel/media-sharp';
import { FakeTextModel } from '@mycel/core/testing';
import { OpenAITextModel } from '@mycel/assist-openai';
import { createAuthenticator, type Authenticator } from './auth.js';
import { createDnsResolver } from './dns.js';
import type { HttpObservability } from './app.js';
import { assessWorker, type WorkerReadiness } from './health.js';
import type { PlatformDeps } from './platform.js';
import { RECURRING_JOBS, jobHandlers } from './jobs.js';
import { HmacInputHasher, HmacSigner } from './signer.js';
import { checkedDestination, webhookTransport } from './webhook.js';

export { createAuthenticator, type Authenticator, type AuthenticatorDeps } from './auth.js';

const isHttps = (url: string | undefined) => url?.startsWith('https://') ?? false;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** `a, b,c` to `['a', 'b', 'c']`; an empty or unset value is an empty list. */
const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

const Config = z
  .object({
    NODE_ENV: z.string().default('development'),
    /**
     * Operator role (schema owner): migrations, seed, and the outbox and job workers when they run
     * in this process. Only `startWorker` uses it; the fronts and the platform API never need it.
     */
    DATABASE_URL: z.string().url().optional(),
    /** Application role (mycel_app), subject to RLS. Required: fronts never run as the owner. */
    APP_DATABASE_URL: z.string().url(),
    /**
     * Authentication login (mycel_authenticator, 0007): it can only enter mycel_auth, which reads
     * memberships and keys across tenants. Required: every front authenticates.
     */
    AUTH_DATABASE_URL: z.string().url(),
    SIGNING_SECRET: z.string().min(16),
    PUBLIC_BASE_URL: z.string().url(),
    MAIL_FROM: z.string().min(3),
    MAILER: z.enum(['console', 'tem']).default('console'),
    /** Console mailer only: also write each message as JSON here (the e2e flow reads it). */
    MAIL_SPOOL_DIR: z.string().optional(),
    TEM_SECRET_KEY: z.string().optional(),
    TEM_PROJECT_ID: z.string().optional(),
    TEM_REGION: z.string().default('fr-par'),
    /**
     * How long after an attempt the provider's listing is trusted to show it before a missing
     * message counts as not sent (brief #22C, docs/reference/mail.md). Scaleway documents no
     * indexing delay; 15 is an assumption with a budget until someone measures it.
     */
    MAIL_RECONCILE_LAG_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    ASSIST_PROVIDER: z.enum(['none', 'fake', 'openai-compatible']).default('none'),
    ASSIST_PROVIDER_LABEL: z.string().min(1).optional(),
    ASSIST_BASE_URL: z.string().url().optional(),
    ASSIST_API_KEY: z.string().optional(),
    ASSIST_TEXT_MODEL: z.string().optional(),
    ASSIST_VISION_MODEL: z.string().optional(),
    ASSIST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
    ASSIST_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** The API key an MCP process acts with; also seed input (`npm run db:seed`). */
    MYCEL_API_KEY: z.string().min(8).optional(),
    /** Operator login (apps/web). Without an issuer the admin answers 503 and the sites work. */
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    /** Set for a confidential client (client_secret_post); unset means a public client. */
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_SCOPES: z.string().default('openid profile email'),
    /**
     * Every tenant gets `<slug>.<PLATFORM_DOMAIN>` at creation (ADR 014 rule 2). `localhost` in
     * development: browsers resolve `probe.localhost` to loopback without a hosts entry.
     */
    PLATFORM_DOMAIN: z
      .string()
      .min(1)
      .transform((d) => normalizeHostname(d)),
    /**
     * Hosts that serve the `/{tenant}/...` path form when no hostname matches (ADR 014 rule 4).
     * Default `localhost,127.0.0.1` outside production; must be empty in production.
     */
    DEV_HOSTS: z.string().optional(),
    /**
     * `hostnames`: absolute site URLs use the tenant's primary hostname; `path`: the path form on
     * PUBLIC_BASE_URL. Default `path` outside production, where a `*.localhost` link is a nuisance
     * for tools that do not resolve it; production is always `hostnames`.
     */
    SITE_URL_MODE: z.enum(['hostnames', 'path']).optional(),
    /**
     * `1` when a reverse proxy (Caddy) fronts the web app: the container then reads host,
     * protocol and client address from the `x-forwarded-*` headers (docker/entrypoint.sh).
     * Without a proxy those headers are spoofable and stay ignored. Required in production.
     */
    MYCEL_TRUST_PROXY: z.enum(['0', '1']).default('0'),
    /**
     * Bearer token of the platform API (`/platform/*`, TODO #16), for the hoster's portal. Unset:
     * the routes do not exist and tenants are managed with the `mycel` CLI. Needs nothing but
     * AUTH_DATABASE_URL: the routes enter `mycel_platform` from that login (0010, ADR 011 rule 1).
     */
    PLATFORM_API_TOKEN: z.string().min(32).optional(),
    /** Where the "Runs on Mycel" footer credit links (ADR 015 rule 5). */
    PLATFORM_CREDIT_URL: z.string().url().default('https://mycel.dev'),
    /**
     * Where media files live (TODO #10): `fs` (a directory, BLOB_DIR) for development, the e2e
     * gate and a small self-host; `s3` (any S3-compatible bucket, private) in production.
     */
    BLOB_STORE: z.enum(['fs', 's3']).optional(),
    /**
     * The `fs` store's directory. A relative path is taken from the repository root, so the web
     * app (run from apps/web) and the API (from packages/api) share one store in development.
     */
    BLOB_DIR: z.string().min(1).default('.scratch/blob'),
    BLOB_S3_ENDPOINT: z.string().url().optional(),
    BLOB_S3_REGION: z.string().min(1).default('us-east-1'),
    BLOB_S3_BUCKET: z.string().min(1).optional(),
    BLOB_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    BLOB_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** `1` for MinIO-style endpoints that do not serve virtual-hosted buckets. */
    BLOB_S3_FORCE_PATH_STYLE: z.enum(['0', '1']).default('0'),
    /** debug, info, warn or error (docs/reference/observability.md); anything else is info. */
    LOG_LEVEL: z.string().optional(),
    /**
     * A Sentry DSN; GlitchTip (self-hosted, EU) accepts the same. Empty or unset: errors go to the
     * log only. Nothing but the exception and a few ids is sent (brief #17a decision 5).
     */
    ERROR_REPORTING_DSN: z.union([z.literal(''), z.string().url()]).optional(),
    /** The tracker's environment tag; defaults to NODE_ENV. */
    ERROR_REPORTING_ENVIRONMENT: z.string().min(1).optional(),
    /** Bearer token for the API's `/metrics`. Unset: the route is a 404. */
    METRICS_TOKEN: z.string().min(32).optional(),
    /** The worker's `/readyz` fails when outbox or job lag reaches this many seconds. */
    READY_MAX_LAG_SECONDS: z.coerce.number().int().min(1).default(900),
    /** Finished jobs older than this many days are deleted by the daily `jobs.retention`. */
    JOBS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    /**
     * Key of the audit log's input hash (TODO #17b, docs/reference/audit.md). Required in
     * production; elsewhere a fixed development key. Rotating it makes older hashes unlinkable.
     */
    AUDIT_HASH_KEY: z.string().min(16).optional(),
    /** Separate encryption key for tenant connector credentials (32 bytes as hex). */
    CONNECTION_CREDENTIAL_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional(),
    /**
     * Audit rows older than this many days are deleted by the daily `audit.retention`. 400: a
     * year-end review still looks back a full year. The database keeps 30 days whatever this says.
     */
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(400),
    /**
     * How many days an archive a tenant administrator asked for (`tenant.export`, TODO #28) can be
     * downloaded; the daily `tenant.export.expire` deletes it after that. Short on purpose: the
     * archive holds every supporter of the site.
     */
    EXPORT_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  })
  .refine(
    (c) =>
      !(
        c.NODE_ENV === 'production' &&
        (c.PLATFORM_DOMAIN === 'localhost' || IPV4.test(c.PLATFORM_DOMAIN))
      ),
    {
      message: 'PLATFORM_DOMAIN must be a real domain in production',
    }
  )
  .refine((c) => !(c.NODE_ENV === 'production' && list(c.DEV_HOSTS).length > 0), {
    message: 'DEV_HOSTS must be empty in production (the path form is development only)',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.SITE_URL_MODE === 'path'), {
    message: 'SITE_URL_MODE=path is not allowed in production',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.MYCEL_TRUST_PROXY !== '1'), {
    message: 'MYCEL_TRUST_PROXY=1 is required in production (the web app runs behind a proxy)',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && !c.AUDIT_HASH_KEY), {
    message: 'AUDIT_HASH_KEY is required in production',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && !c.CONNECTION_CREDENTIAL_KEY), {
    message: 'CONNECTION_CREDENTIAL_KEY is required in production',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.MAILER === 'console'), {
    message: 'MAILER=console is not allowed in production',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.MAIL_SPOOL_DIR), {
    message: 'MAIL_SPOOL_DIR is not allowed in production',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.ASSIST_PROVIDER === 'fake'), {
    message: 'ASSIST_PROVIDER=fake is not allowed in production',
  })
  .refine(
    (c) =>
      c.ASSIST_PROVIDER !== 'openai-compatible' ||
      (c.ASSIST_PROVIDER_LABEL &&
        c.ASSIST_BASE_URL &&
        c.ASSIST_TEXT_MODEL &&
        c.ASSIST_VISION_MODEL),
    { message: 'openai-compatible assistance needs LABEL, BASE_URL, TEXT_MODEL and VISION_MODEL' }
  )
  .refine(
    (c) =>
      c.ASSIST_PROVIDER !== 'openai-compatible' ||
      !c.ASSIST_API_KEY ||
      isHttps(c.ASSIST_BASE_URL) ||
      (c.NODE_ENV !== 'production' &&
        ['localhost', '127.0.0.1', '::1'].includes(new URL(c.ASSIST_BASE_URL!).hostname)),
    { message: 'ASSIST_API_KEY needs an HTTPS API root (local HTTP is development-only)' }
  )
  .refine((c) => !(c.NODE_ENV === 'production' && blobStoreOf(c) !== 's3'), {
    message: 'BLOB_STORE=s3 is required in production (a directory is not backed up with the data)',
  })
  .refine(
    (c) =>
      blobStoreOf(c) !== 's3' ||
      (c.BLOB_S3_BUCKET && c.BLOB_S3_ACCESS_KEY_ID && c.BLOB_S3_SECRET_ACCESS_KEY),
    {
      message:
        'BLOB_STORE=s3 needs BLOB_S3_BUCKET, BLOB_S3_ACCESS_KEY_ID and BLOB_S3_SECRET_ACCESS_KEY',
    }
  )
  .refine((c) => !c.OIDC_ISSUER || c.OIDC_CLIENT_ID, {
    message: 'OIDC_ISSUER needs OIDC_CLIENT_ID',
  })
  // Production login runs over TLS end to end: a real IdP (never the http mock) and a Secure
  // session cookie, which browsers only keep for an https origin.
  .refine((c) => !(c.NODE_ENV === 'production' && c.OIDC_ISSUER && !isHttps(c.OIDC_ISSUER)), {
    message: 'OIDC_ISSUER must be https in production',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.OIDC_ISSUER && !isHttps(c.PUBLIC_BASE_URL)), {
    message: 'PUBLIC_BASE_URL must be https in production when operator login is configured',
  });
export type RuntimeConfig = z.infer<typeof Config>;

/** Every key the runtime reads; `.env.example` must name each of them (env-example.test.ts). */
export const CONFIG_KEYS: readonly string[] = Object.keys(Config.shape);

/** `fs` unless set: a production config without BLOB_STORE fails the refine above. */
function blobStoreOf(c: { BLOB_STORE?: 'fs' | 's3' | undefined }): 'fs' | 's3' {
  return c.BLOB_STORE ?? 'fs';
}

/** The S3 settings of the configuration, or null when it names the `fs` store. */
export function s3ConfigOf(config: RuntimeConfig): S3BlobStoreConfig | null {
  return blobStoreOf(config) === 's3'
    ? {
        endpoint: config.BLOB_S3_ENDPOINT,
        region: config.BLOB_S3_REGION,
        bucket: config.BLOB_S3_BUCKET ?? '',
        accessKeyId: config.BLOB_S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: config.BLOB_S3_SECRET_ACCESS_KEY ?? '',
        forcePathStyle: config.BLOB_S3_FORCE_PATH_STYLE === '1',
      }
    : null;
}

/** The BlobStore the configuration names; S3 credentials were checked by `loadConfig`. */
export function blobStoreFor(config: RuntimeConfig): BlobStore {
  const s3 = s3ConfigOf(config);
  return s3
    ? createS3BlobStore(s3)
    : createFsBlobStore(
        isAbsolute(config.BLOB_DIR)
          ? config.BLOB_DIR
          : resolve(fileURLToPath(new URL('../../..', import.meta.url)), config.BLOB_DIR)
      );
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const parsed = Config.safeParse(env);
  if (!parsed.success)
    throw new Error(
      'invalid configuration (see .env.example):\n' +
        parsed.error.issues
          .map((i) => `  ${i.path.join('.') || '(config)'}: ${i.message}`)
          .join('\n')
    );
  return parsed.data;
}

/** `Name <addr@x>` or `addr@x`. */
function parseAddress(value: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  return m && m[1] ? { name: m[1], email: m[2]! } : { email: m?.[2] ?? value.trim() };
}

/** Outside production only: the audit hash key when AUDIT_HASH_KEY is unset (`.env.example`). */
export const DEV_AUDIT_HASH_KEY = 'mycel-dev-audit-hash-key';

/** The audit input hasher of this configuration. */
export function inputHasherOf(config: RuntimeConfig): HmacInputHasher {
  return new HmacInputHasher(config.AUDIT_HASH_KEY ?? DEV_AUDIT_HASH_KEY);
}

/** The platform settings the core reads inside a transaction, derived from the config once. */
export function platformOf(config: RuntimeConfig): PlatformConfig {
  const production = config.NODE_ENV === 'production';
  return {
    domain: config.PLATFORM_DOMAIN,
    devHosts:
      config.DEV_HOSTS === undefined && !production
        ? ['localhost', '127.0.0.1']
        : list(config.DEV_HOSTS),
    platformOrigin: new URL(config.PUBLIC_BASE_URL).origin,
    siteUrlMode: config.SITE_URL_MODE ?? (production ? 'hostnames' : 'path'),
  };
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
  signer: HmacSigner;
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
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer,
    dns: createDnsResolver(),
    platform,
    media: { blobs, images: createSharpProcessor(), delivery: appDelivery },
    log,
    inputHasher,
    connectionCredentialKey: config.CONNECTION_CREDENTIAL_KEY,
    connectionDestinationValidator: async (url) => {
      await checkedDestination(url);
    },
    assistProviderLabel,
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
          (text) => log.info('console mailer', { mail: text }),
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
    reconcileLagMs: config.MAIL_RECONCILE_LAG_MINUTES * 60 * 1000,
  };
  const subscribers = [supporterIngestSubscriber(uow), confirmationMailSubscriber(confirmation)];
  // What `mail.reconcile` rebuilds a message with, per mail subscriber above.
  const mailSources = { [CONFIRMATION_SUBSCRIBER]: confirmationMailSource(confirmation) };
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
    ? {
        token: platformToken,
        store: {
          create: (input) => createTenant(authDb, { id: uuidv7(), ...input }, platform, by()),
          list: () => listTenants(authDb),
          get: (id) => getTenant(authDb, id),
          setEntitlements: (id, document) => setEntitlements(authDb, id, document, by()),
          setStatus: (id, status) => setStatus(authDb, id, status, by()),
          // As mycel_ops from the same login (0016): stuck rows without payloads.
          ops: {
            summary: () => opsSummary(authDb),
            jobs: (q) => opsJobs(authDb, q),
            outbox: (q) => opsDeadEvents(authDb, q),
            mail: (q) => opsUnresolvedMail(authDb, q),
            retryJob: (id) => opsRetryJob(authDb, id, by()),
            closeJob: (id) => opsCloseJob(authDb, id, by()),
            retryEvent: (id) => opsRetryEvent(authDb, id, by()),
          },
        },
      }
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
          transport: webhookTransport(),
          sources: {
            'synthetic.test': {
              async prepare(_ctx, intent) {
                return intent.source === 'synthetic.test' &&
                  intent.supporterId === null &&
                  intent.scope === 'synthetic:test'
                  ? { ready: true, payload: { category: 'synthetic.test' } }
                  : { ready: false, failure: 'source' };
              },
            } satisfies ConnectionSource,
          },
        },
      });
      const stopJobs = startJobWorker(operatorDb, inJobContext(handlers), {
        intervalMs: JOBS_INTERVAL_MS,
        recurring: RECURRING_JOBS,
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
