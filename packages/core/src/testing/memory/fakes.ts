// The stateless fakes of the in-memory runtime: clock, ids, signer, hasher, mailer, DNS, logger.
// None of them reads a MemoryStore, so suites can use them without a unit of work.

import type { InputHasher } from '../../audit/ports.js';
import type { MailMessage, Mailer } from '../../mailing/ports.js';
import type { Clock, ErrorReporter, Ids, LogFields, Logger, Signer } from '../../ports.js';
import type {
  DnsResolver,
  PlatformConfig,
  TenantDirectory,
  TenantInfo,
} from '../../tenants/ports.js';
import { bytesToHex } from '../../util/bytes.js';
import { normalizeEmail } from '../../util/email.js';
import { exampleId } from '../../util/ids.js';
import { DnsUnavailableError } from '../../tenants/ports.js';

export class FakeClock implements Clock {
  constructor(public current = new Date('2026-10-21T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Deterministic, valid-looking UUIDv7 strings for tests. */
export class SequentialIds implements Ids {
  #n = 0;
  next(): string {
    this.#n += 1;
    return exampleId(this.#n);
  }
}

/** Not secure: "signature" is a reversed payload. Enough to test token logic in the core. */
export class FakeSigner implements Signer {
  async sign(payload: string): Promise<string> {
    return `${payload}~${[...payload].reverse().join('')}`;
  }
  async verify(token: string): Promise<string | null> {
    const i = token.lastIndexOf('~');
    if (i < 0) return null;
    const payload = token.slice(0, i);
    return [...payload].reverse().join('') === token.slice(i + 1) ? payload : null;
  }
  hashIp(ip: string): string {
    return `ip~${[...ip].reverse().join('')}`;
  }
}

/**
 * HMAC-SHA256 over Web Crypto with a fixed test key, so hashes are real (64 hex) and a different
 * key gives a different hash, without the API's node:crypto adapter.
 */
export class FakeInputHasher implements InputHasher {
  readonly #key: ReturnType<typeof globalThis.crypto.subtle.importKey>;
  constructor(key = 'mycel-test-audit-key') {
    this.#key = globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }
  async hash(canonical: string): Promise<string> {
    const mac = await globalThis.crypto.subtle.sign(
      'HMAC',
      await this.#key,
      new TextEncoder().encode(canonical)
    );
    return bytesToHex(new Uint8Array(mac));
  }
}

/** The `by` argument of the platform functions in packages/db, for suites. */
export const testPlatformActor = { actorId: 'test', hasher: new FakeInputHasher() };

/** Records every delivery with its intent key; `lookup` lists what was sent to that address. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  readonly keys = new Set<string>();
  readonly #log: { id: string; to: string; subject: string }[] = [];
  async send(message: MailMessage, key: string): Promise<{ providerId: string }> {
    this.sent.push(message);
    this.keys.add(key);
    const id = `mem-${this.sent.length}`;
    this.#log.push({ id, to: normalizeEmail(message.to.email), subject: message.subject });
    return { providerId: id };
  }
  async lookup(message: MailMessage): Promise<{ providerIds: string[] }> {
    const to = normalizeEmail(message.to.email);
    return {
      providerIds: this.#log
        .filter((m) => m.to === to && m.subject === message.subject)
        .map((m) => m.id),
    };
  }
}

export class MemoryTenants implements TenantDirectory {
  constructor(readonly tenants: TenantInfo[] = []) {}
  async findById(id: string) {
    return this.tenants.find((t) => t.id === id) ?? null;
  }
  async findBySlug(slug: string) {
    return this.tenants.find((t) => t.slug === slug) ?? null;
  }
}

/** Development defaults, the shape `.env.example` gives: path form on localhost. */
export const memoryPlatform: PlatformConfig = {
  domain: 'localhost',
  devHosts: ['localhost', '127.0.0.1'],
  platformOrigin: 'http://localhost:5173',
  siteUrlMode: 'path',
};

/**
 * Answers from a table; a name without an entry is "not found", like a real resolver. A name in
 * `unavailable` answers nothing at all (a server failure or a time-out).
 */
export class FakeDns implements DnsResolver {
  readonly txtRecords = new Map<string, string[]>();
  readonly cnames = new Map<string, string>();
  readonly unavailable = new Set<string>();
  /**
   * A/AAAA answers. By default only the webhook host of the use-case examples and fixtures
   * (`hooks.example.org`) resolves, to a public address; a test passes its own map instead.
   */
  readonly addressRecords: Map<string, string[]>;
  constructor(
    addresses: Readonly<Record<string, string[]>> = { 'hooks.example.org': ['8.8.8.8'] }
  ) {
    this.addressRecords = new Map(Object.entries(addresses));
  }
  async txt(name: string): Promise<string[]> {
    if (this.unavailable.has(name)) throw new DnsUnavailableError();
    return [...(this.txtRecords.get(name) ?? [])];
  }
  async cname(name: string): Promise<string | null> {
    if (this.unavailable.has(name)) throw new DnsUnavailableError();
    return this.cnames.get(name) ?? null;
  }
  async addresses(name: string): Promise<string[]> {
    if (this.unavailable.has(name)) throw new DnsUnavailableError();
    return [...(this.addressRecords.get(name) ?? [])];
  }
}

/** Keeps every line it is given, for assertions; `child` shares the list. */
export class MemoryLogger implements Logger {
  constructor(
    readonly lines: { level: string; message: string; fields: LogFields }[] = [],
    private readonly base: LogFields = {}
  ) {}
  #push(level: string, message: string, fields: LogFields = {}) {
    this.lines.push({ level, message, fields: { ...this.base, ...fields } });
  }
  debug(message: string, fields?: LogFields) {
    this.#push('debug', message, fields);
  }
  info(message: string, fields?: LogFields) {
    this.#push('info', message, fields);
  }
  warn(message: string, fields?: LogFields) {
    this.#push('warn', message, fields);
  }
  error(message: string, fields?: LogFields) {
    this.#push('error', message, fields);
  }
  child(fields: LogFields): Logger {
    return new MemoryLogger(this.lines, { ...this.base, ...fields });
  }
}

/** Collects what would go to the error tracker. */
export class MemoryErrorReporter implements ErrorReporter {
  readonly captured: { error: unknown; context: Parameters<ErrorReporter['capture']>[1] }[] = [];
  capture(error: unknown, context?: Parameters<ErrorReporter['capture']>[1]): void {
    this.captured.push({ error, context });
  }
}
