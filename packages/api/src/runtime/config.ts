// Runtime configuration: the one schema every process parses its environment with, and the
// settings derived from it once (platform, audit hasher, S3). Split from compose.ts so
// the composition root reads as wiring; `compose.ts` re-exports all of it, so no caller moved.
// Rejected: a schema per front (each would drift in what production refuses) and splitting the
// schema by subsystem (the production refinements read keys of several at once).

import { z } from 'zod';
import { normalizeHostname, type PlatformConfig } from '@mycel/core';
import type { S3BlobStoreConfig } from '@mycel/blob';
import { HmacInputHasher } from './signer.js';

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
    /**
     * Where this installation's HTTP API is reached from outside. Names it in
     * /.well-known/api-catalog and in the Link header of a public page; unset, neither exists.
     */
    PUBLIC_API_URL: z.string().url().optional(),
    /**
     * Who hears about a vulnerability in this installation: a `mailto:`, `https:` or `tel:` URI.
     * Unset, /.well-known/security.txt is a 404: the project's own address is not the operator's.
     */
    SECURITY_CONTACT: z
      .string()
      .regex(/^(mailto:|https:\/\/|tel:)\S+$/, 'a mailto:, https: or tel: URI')
      .optional(),
    MAIL_FROM: z.string().min(3),
    MAILER: z.enum(['console', 'tem']).default('console'),
    /** Console mailer only: also write each message as JSON here (the e2e flow reads it). */
    MAIL_SPOOL_DIR: z.string().optional(),
    TEM_SECRET_KEY: z.string().optional(),
    TEM_PROJECT_ID: z.string().optional(),
    TEM_REGION: z.string().default('fr-par'),
    /**
     * How long after an attempt the provider's listing is trusted to show it before a missing
     * message counts as not sent (docs/reference/mail.md). Scaleway documents no
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
     * Bearer token of the platform API (`/platform/*`), for the hoster's portal. Unset:
     * the routes do not exist and tenants are managed with the `mycel` CLI. Needs nothing but
     * AUTH_DATABASE_URL: the routes enter `mycel_platform` from that login (0010, ADR 011 rule 1).
     */
    PLATFORM_API_TOKEN: z.string().min(32).optional(),
    /** Where the "Runs on Mycel" footer credit links (ADR 015 rule 5). */
    PLATFORM_CREDIT_URL: z.string().url().default('https://mycel.dev'),
    /**
     * Where media files live: `fs` (a directory, BLOB_DIR) for development, the e2e
     * gate and a small self-host; `s3` (any S3-compatible bucket, private) in production.
     */
    BLOB_STORE: z.enum(['fs', 's3']).optional(),
    /**
     * The `fs` store's directory. A relative path is taken from the repository root, so the web
     * app (run from apps/web) and the API (from packages/api) share one store in development; in
     * a linked git worktree from the main checkout's root (`blobRoot`).
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
     * log only. Nothing but the exception and a few ids is sent (docs/reference/observability.md).
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
     * Key of the audit log's input hash (docs/reference/audit.md). Required in
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
     * How many days an archive a tenant administrator asked for (`tenant.export.create`) can be
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
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.PUBLIC_API_URL && !isHttps(c.PUBLIC_API_URL)), {
    message: 'PUBLIC_API_URL must be https in production',
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
