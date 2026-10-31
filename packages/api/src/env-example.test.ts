// `.env.example` is the one list of configuration a self-hoster reads (TODO #20c decision 6), so it
// has to be complete and nothing in it may be dead. Three sources of keys: the runtime schema
// (`CONFIG_KEYS`), the configuration read outside it (INVENTORY: migrations, seed, compose,
// processes), and keys that deliberately stay out of the example (NOT_IN_EXAMPLE, with the reason).
// Every environment read in the code must be one of the three, so a new `process.env['X']` fails
// here until someone decides where it belongs. Secrets appear only as placeholders.
// Rejected: generating .env.example from the schema, which loses the prose a self-hoster needs.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from './runtime/compose.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

/** Configuration read outside the runtime schema, with the file that reads it. */
const INVENTORY: Record<string, string> = {
  MYCEL_APP_PASSWORD: 'packages/db/src/infra/migrate.ts',
  MYCEL_AUTH_PASSWORD: 'packages/db/src/infra/migrate.ts',
  MYCEL_SEED_OPERATOR_EMAIL: 'packages/db/src/infra/seed.ts',
  MYCEL_IMAGE: 'compose.yml',
  MYCEL_DB_PASSWORD: 'compose.yml',
  PG_SUPERUSER_PASSWORD: 'compose.yml',
  MYCEL_BACKUP_PASSWORD: 'compose.yml',
  RESTIC_REPOSITORY: 'docker/backup/common.sh',
  RESTIC_PASSWORD: 'docker/backup/common.sh',
  AWS_ACCESS_KEY_ID: 'compose.yml',
  AWS_SECRET_ACCESS_KEY: 'compose.yml',
  BACKUP_KEEP_DAILY: 'docker/backup/backup.sh',
  BACKUP_KEEP_WEEKLY: 'docker/backup/backup.sh',
  BACKUP_KEEP_MONTHLY: 'docker/backup/backup.sh',
  BACKUP_CHECK_WEEKDAY: 'docker/backup/backup.sh',
  BACKUP_MAX_SECONDS: 'docker/backup/backup.sh',
  ERASURES_KEEP_LAST: 'docker/backup/backup.sh',
  ERASURES_KEEP_DAILY: 'docker/backup/backup.sh',
  ACME_EMAIL: 'docker/caddy/Caddyfile',
  API_HOST: 'docker/caddy/Caddyfile',
  MYCEL_PG_PORT: 'compose.dev.yml',
  MYCEL_S3_PORT: 'compose.dev.yml',
  MYCEL_WORKER: 'packages/api/src/runtime/server.ts',
};

/** Read by the code, deliberately not in `.env.example`. */
const NOT_IN_EXAMPLE: Record<string, string> = {
  PORT: 'per process, set by whoever starts it (container, scripts/dev.mjs, playwright.config.ts)',
  HOST: 'adapter-node listen address, per process',
  BODY_SIZE_LIMIT: 'set by docker/entrypoint.sh for the web container',
  PROTOCOL_HEADER: 'derived from MYCEL_TRUST_PROXY by docker/entrypoint.sh',
  HOST_HEADER: 'derived from MYCEL_TRUST_PROXY by docker/entrypoint.sh',
  ADDRESS_HEADER: 'derived from MYCEL_TRUST_PROXY by docker/entrypoint.sh',
  XFF_DEPTH: 'derived from MYCEL_TRUST_PROXY by docker/entrypoint.sh',
  PGAPPNAME:
    'libpq session name, per process; scripts/dev.mjs sets it, createDb falls back to script and pid',
  MOCK_OIDC_PORT: 'development IdP, set by scripts/dev.mjs and scripts/e2e/e2e.mjs',
  MOCK_OIDC_USER: 'development IdP, set by scripts/dev.mjs',
  E2E_REQUIRED: 'test harness (CI)',
  E2E_API_URL: 'test harness, set by scripts/e2e/e2e.mjs',
  E2E_API_PORT: 'test harness',
  E2E_OIDC_PORT: 'test harness',
  E2E_WORKER_PORT: 'test harness',
  CI: 'set by the CI runner',
  PATH: 'operating system, passed through by scripts/test-collect.mjs',
  HOME: 'operating system, passed through by scripts/test-collect.mjs',
  GITHUB_REPOSITORY: 'GitHub Actions repository identity, quality baseline lookup',
  GITHUB_RUN_ID: 'GitHub Actions run identity, excludes itself from baseline lookup',
  GITHUB_RUN_ATTEMPT: 'GitHub Actions attempt identity, required quality artifact provenance',
  GITHUB_EVENT_NAME: 'GitHub Actions trigger, required quality matrix selection',
  GITHUB_SHA: 'GitHub Actions measured checkout SHA, required quality artifact provenance',
  QUALITY_NEEDS: 'GitHub Actions upstream results and matrix, set by the quality gate step',
  QUALITY_DOWNLOAD_OUTCOME:
    'GitHub Actions artifact download outcome, set by the quality gate step',
  QUALITY_RUNNER_IMAGE: 'digest-pinned quality measurement container, set by its workflow',
  QUALITY_HOST_IMAGE: 'actual GitHub host image forwarded to the measurement container',
  GITHUB_ACTIONS: 'GitHub Actions runner detection for quality provenance',
  ImageVersion: 'GitHub hosted runner image build, quality provenance',
  EVENT: 'quality workflow matrix event, set by its Matrix step',
  MEASUREMENT_OUTCOME: 'quality workflow observation result, set by its status step',
  MYCEL_VERSION: 'set by the release image from its build argument (Dockerfile)',
  STAGING_DIR: 'set by the backup image (docker/backup/Dockerfile)',
  PGUSER: 'set by compose.yml per backup service (backup: mycel_backup, restore: the owner)',
  PGPASSWORD: 'built by compose.yml from MYCEL_BACKUP_PASSWORD or MYCEL_DB_PASSWORD',
  PGDATABASE: 'set by compose.yml for the backup services',
  DRILL_BACKUP_DATABASE_URL: 'restore drill harness, set by scripts/drill/drill-run.sh',
  BACKUP_HOLD_AFTER_DUMP: 'restore drill harness, passed by scripts/drill/drill-run.sh (TODO #29A)',
};

/**
 * Credentials of the local services in compose.dev.yml (bound to 127.0.0.1): they must equal
 * what compose starts, so they cannot be a `change-me` placeholder.
 */
const LOCAL_SERVICE_CREDENTIALS = new Set(['DATABASE_URL', 'BLOB_S3_SECRET_ACCESS_KEY']);
const SECRET = /SECRET|PASSWORD|TOKEN|_KEY$|_DSN$|DATABASE_URL$/;

/** Keys named in an example file, set (`K=v`) or documented as commented out (`# K=v`). */
export function exampleKeys(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^(?:#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) keys.set(m[1]!, m[2]!.replace(/^"|"$/g, ''));
  }
  return keys;
}

/** Every problem with an example file; empty when it is complete and has no dead keys. */
export function checkEnvExample(
  text: string,
  sources: { schema: readonly string[]; inventory: readonly string[]; used: readonly string[] }
): string[] {
  const keys = exampleKeys(text);
  const expected = new Set([...sources.schema, ...sources.inventory]);
  const problems: string[] = [];
  for (const key of expected) if (!keys.has(key)) problems.push(`${key}: missing from the example`);
  for (const key of keys.keys())
    if (!expected.has(key)) problems.push(`${key}: in the example, but nothing reads it`);
  for (const key of sources.used)
    if (!expected.has(key) && !(key in NOT_IN_EXAMPLE))
      problems.push(`${key}: read by the code, but not in the schema or the inventory`);
  for (const [key, value] of keys)
    if (SECRET.test(key) && value && !LOCAL_SERVICE_CREDENTIALS.has(key)) {
      const secretPart = key.endsWith('DATABASE_URL')
        ? /\/\/[^:]+:([^@]+)@/.exec(value)?.[1]
        : value;
      if (secretPart && !secretPart.includes('change-me'))
        problems.push(`${key}: a secret needs a change-me placeholder, not a usable value`);
    }
  return problems;
}

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'build', '.svelte-kit', 'fixtures'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

/** Environment keys the shipped code and its tooling read (tests and e2e specs excluded). */
function usedKeys(): string[] {
  const used = new Set<string>();
  const scan = (file: string, pattern: RegExp) => {
    for (const m of readFileSync(file, 'utf8').matchAll(pattern)) used.add(m[1]!);
  };
  const processEnv = /process\.env(?:\.|\[\s*['"])([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const dir of ['packages', 'apps/web/src', 'scripts'])
    for (const file of files(join(root, dir)))
      if (/\.(ts|mjs|js|svelte)$/.test(file) && !/\.test\.(ts|mjs)$/.test(file))
        if (!relative(root, file).includes('/e2e/')) scan(file, processEnv);
  scan(join(root, 'apps/web/playwright.config.ts'), processEnv);
  const shell = /\$\{([A-Z][A-Z0-9_]*)/g;
  for (const file of [
    'compose.yml',
    'compose.dev.yml',
    'docker/entrypoint.sh',
    'docker/backup/common.sh',
    'docker/backup/backup.sh',
    'docker/backup/restore.sh',
  ])
    scan(join(root, file), shell);
  scan(join(root, 'docker/caddy/Caddyfile'), /\{\$([A-Z][A-Z0-9_]*)/g);
  return [...used];
}

describe('.env.example', () => {
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  const sources = {
    schema: CONFIG_KEYS,
    inventory: Object.keys(INVENTORY),
    used: usedKeys(),
  };

  it('names every key the code reads, and nothing else', () => {
    expect(checkEnvExample(example, sources)).toEqual([]);
  });

  it('inventories each outside key next to a consumer that still reads it', () => {
    for (const [key, file] of Object.entries(INVENTORY))
      expect(readFileSync(join(root, file), 'utf8'), `${key} in ${file}`).toContain(key);
  });

  it('fails on a missing key, a dead key, an unlisted read and a usable secret', () => {
    const broken = example
      .replace(/^SIGNING_SECRET=.*$/m, 'SIGNING_SECRET=a-real-looking-secret')
      .replace(/^MAIL_FROM=.*$/m, '')
      .concat('\nNOBODY_READS_THIS=1\n');
    expect(
      checkEnvExample(broken, { ...sources, used: [...sources.used, 'NEW_UNLISTED_KEY'] })
    ).toEqual([
      'MAIL_FROM: missing from the example',
      'NOBODY_READS_THIS: in the example, but nothing reads it',
      'NEW_UNLISTED_KEY: read by the code, but not in the schema or the inventory',
      'SIGNING_SECRET: a secret needs a change-me placeholder, not a usable value',
    ]);
  });
});
