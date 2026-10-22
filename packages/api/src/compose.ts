// Composition root (docs/architecture/overview.md): the one place that turns configuration into
// adapter instances and hands fronts an Invoker. The HTTP server, the MCP server and the web app
// all call `createRuntime`, so no front wires adapters itself and none can wire them differently.
// Rejected: a composition file per front (the overview's first sketch), which the probe showed
// would triplicate config parsing, signer setup and subscriber lists.

import { z } from 'zod';
import {
  Invoker,
  buildRegistry,
  confirmationMailSubscriber,
  normalizeHostname,
  siteUrl,
  supporterIngestSubscriber,
  type Clock,
  type IdentityStore,
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
  createDb,
  createIdentityStore,
  createSiteDirectory,
  createTenantDirectory,
  createUnitOfWork,
  startJobWorker,
  startOutboxWorker,
  uuidv7,
  uuidv7Ids,
} from '@mycel/db';
import { ConsoleMailer, TemMailer } from '@mycel/mail-tem';
import { createAuthenticator, type Authenticator } from './auth.js';
import { createDnsResolver } from './dns.js';
import { RECURRING_JOBS, jobHandlers } from './jobs.js';
import { HmacSigner } from './signer.js';

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
     * in this process. Only `startWorker` uses it; the web front never needs it.
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
  .refine((c) => !(c.NODE_ENV === 'production' && c.MAILER === 'console'), {
    message: 'MAILER=console is not allowed in production',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.MAIL_SPOOL_DIR), {
    message: 'MAIL_SPOOL_DIR is not allowed in production',
  })
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

export interface Runtime {
  config: RuntimeConfig;
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
  subscribers: Subscriber[];
  /** Authentication-time lookups (operators, memberships, keys) as mycel_auth. */
  identity: IdentityStore;
  /** Principal for a bearer token from `api_keys`, or null when unknown or revoked. */
  authenticateApiKey: Authenticator['authenticateApiKey'];
  /** Principal for an MCP session from MYCEL_API_KEY's row (stdio: whoever holds the env). */
  agentPrincipal: Authenticator['agentPrincipal'];
  /** Start draining the outbox and running due jobs in this process. Needs DATABASE_URL. */
  startWorker(): () => Promise<void>;
  close(): Promise<void>;
}

export function createRuntime(config: RuntimeConfig = loadConfig()): Runtime {
  const clock: Clock = { now: () => new Date() };
  const signer = new HmacSigner(config.SIGNING_SECRET);
  const appDb = createDb(config.APP_DATABASE_URL);
  const authDb = createDb(config.AUTH_DATABASE_URL);
  const operatorDb = config.DATABASE_URL ? createDb(config.DATABASE_URL) : null;
  const platform = platformOf(config);
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer,
    dns: createDnsResolver(),
    platform,
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
  const invoker = new Invoker(buildRegistry(), uow);
  const mailer: Mailer =
    config.MAILER === 'tem'
      ? new TemMailer({
          secretKey: config.TEM_SECRET_KEY ?? '',
          projectId: config.TEM_PROJECT_ID ?? '',
          region: config.TEM_REGION,
        })
      : new ConsoleMailer(undefined, config.MAIL_SPOOL_DIR);
  const subscribers = [
    supporterIngestSubscriber(uow),
    confirmationMailSubscriber({
      mailer,
      signer,
      clock,
      tenants,
      uow,
      from: parseAddress(config.MAIL_FROM),
      platform,
    }),
  ];
  const stops: (() => Promise<void>)[] = [];

  return {
    config,
    platform,
    invoker,
    uow,
    tenants,
    sites,
    siteUrl: (site, path) => siteUrl(site, platform, path),
    clock,
    signer,
    mailer,
    subscribers,
    identity,
    authenticateApiKey: auth.authenticateApiKey,
    agentPrincipal: auth.agentPrincipal,
    startWorker() {
      if (!operatorDb) throw new Error('the worker needs DATABASE_URL (operator role)');
      const stopOutbox = startOutboxWorker(operatorDb, subscribers);
      const stopJobs = startJobWorker(operatorDb, jobHandlers({ uow, operatorDb }), {
        intervalMs: 5000,
        recurring: RECURRING_JOBS,
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
