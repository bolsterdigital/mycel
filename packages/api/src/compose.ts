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
  supporterIngestSubscriber,
  type Clock,
  type Mailer,
  type Principal,
  type Subscriber,
  type TenantDirectory,
  type UnitOfWork,
} from '@mycel/core';
import {
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  startOutboxWorker,
  uuidv7,
  uuidv7Ids,
} from '@mycel/db';
import { ConsoleMailer, TemMailer } from '@mycel/mail-tem';
import { timingSafeEqual } from 'node:crypto';
import { HmacSigner } from './signer.js';

const Config = z
  .object({
    NODE_ENV: z.string().default('development'),
    /** Operator role: migrations, seed, outbox drain. Optional for fronts that run no worker. */
    DATABASE_URL: z.string().url().optional(),
    /** Application role (mycel_app), subject to RLS. Required: fronts never run as the owner. */
    APP_DATABASE_URL: z.string().url(),
    SIGNING_SECRET: z.string().min(16),
    PUBLIC_BASE_URL: z.string().url(),
    MAIL_FROM: z.string().min(3),
    MAILER: z.enum(['console', 'tem']).default('console'),
    TEM_SECRET_KEY: z.string().optional(),
    TEM_PROJECT_ID: z.string().optional(),
    TEM_REGION: z.string().default('fr-par'),
    MYCEL_API_KEY: z.string().min(8).optional(),
    MYCEL_API_KEY_TENANT: z.string().optional(),
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.MAILER === 'console'), {
    message: 'MAILER=console is not allowed in production',
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

export interface Runtime {
  config: RuntimeConfig;
  invoker: Invoker;
  uow: UnitOfWork;
  tenants: TenantDirectory;
  clock: Clock;
  signer: HmacSigner;
  mailer: Mailer;
  subscribers: Subscriber[];
  /** Principal for a bearer token, or null. One static key from env in the probe. */
  authenticateApiKey(authorization: string | undefined): Promise<Principal | null>;
  /** Principal for an MCP session (stdio: whoever can start the process holds the env). */
  agentPrincipal(): Promise<Principal>;
  /** Start draining the outbox in this process. Needs DATABASE_URL. */
  startWorker(): () => Promise<void>;
  close(): Promise<void>;
}

export function createRuntime(config: RuntimeConfig = loadConfig()): Runtime {
  const clock: Clock = { now: () => new Date() };
  const signer = new HmacSigner(config.SIGNING_SECRET);
  const appDb = createDb(config.APP_DATABASE_URL);
  const operatorDb = config.DATABASE_URL ? createDb(config.DATABASE_URL) : null;
  const uow = createUnitOfWork(appDb, { clock, ids: uuidv7Ids, signer });
  const tenants = createTenantDirectory(appDb);
  const invoker = new Invoker(buildRegistry(), uow);
  const mailer: Mailer =
    config.MAILER === 'tem'
      ? new TemMailer({
          secretKey: config.TEM_SECRET_KEY ?? '',
          projectId: config.TEM_PROJECT_ID ?? '',
          region: config.TEM_REGION,
        })
      : new ConsoleMailer();
  const subscribers = [
    supporterIngestSubscriber(uow),
    confirmationMailSubscriber({
      mailer,
      signer,
      clock,
      tenants,
      from: parseAddress(config.MAIL_FROM),
      publicBaseUrl: config.PUBLIC_BASE_URL,
    }),
  ];
  const stops: (() => Promise<void>)[] = [];

  async function keyTenant(): Promise<string> {
    const slug = config.MYCEL_API_KEY_TENANT;
    const tenant = slug ? await tenants.findBySlug(slug) : null;
    if (!tenant) throw new Error(`MYCEL_API_KEY_TENANT "${slug ?? ''}" does not name a tenant`);
    return tenant.id;
  }

  return {
    config,
    invoker,
    uow,
    tenants,
    clock,
    signer,
    mailer,
    subscribers,
    async authenticateApiKey(authorization) {
      const key = config.MYCEL_API_KEY;
      const given = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
      if (!key || !given) return null;
      const a = Buffer.from(given);
      const b = Buffer.from(key);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      return {
        tenantId: await keyTenant(),
        actor: { kind: 'api-key', keyId: 'env' },
        capabilities: ['tenant:admin'],
      };
    },
    async agentPrincipal() {
      return {
        tenantId: await keyTenant(),
        actor: { kind: 'agent', sessionId: uuidv7() },
        capabilities: ['tenant:admin'],
      };
    },
    startWorker() {
      if (!operatorDb) throw new Error('the outbox worker needs DATABASE_URL (operator role)');
      const stop = startOutboxWorker(operatorDb, subscribers);
      stops.push(stop);
      return stop;
    },
    async close() {
      await Promise.all(stops.map((s) => s()));
      await appDb.destroy();
      await operatorDb?.destroy();
    },
  };
}
