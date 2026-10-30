// testing.md rule 3, once: a suite that needs an outside service (Postgres, S3) skips locally
// without it and fails in CI, where `E2E_REQUIRED=1`. Every suite asks here instead of comparing
// `E2E_REQUIRED` itself, so the rule cannot be copied wrong (the #99 slip in setup.conformance);
// `scripts/gates/testing-shape.test.mjs` keeps the comparison in this file. The environment is a
// parameter because core reads no process state; callers pass `process.env`.
// Rejected: a Vitest global setup that fails the run (it cannot tell which suite needed what),
// and one helper per package (blob needs it too and depends on core alone).

type Env = Readonly<Record<string, string | undefined>>;

/** True when a missing service is a failure, not a skip: CI. */
const required = (env: Env) => env['E2E_REQUIRED'] === '1';

/**
 * The values of `keys` in `env`, or `null` when one is missing, so the suite skips
 * (`describe.skipIf(!values)`). With `E2E_REQUIRED=1` a missing key throws instead. Call it at
 * module level: with an empty environment (`test:collect`) it returns `null`.
 */
export function requireServices<K extends string>(
  env: Env,
  keys: readonly K[]
): Record<K, string> | null {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length === 0) return Object.fromEntries(keys.map((k) => [k, env[k]!])) as never;
  if (required(env)) throw new Error(`E2E_REQUIRED=1 but ${missing.join(', ')} is not set`);
  return null;
}

/**
 * The same rule for a condition only known at run time (a role attribute, a record the suite
 * could write): returns `ok`, and throws `E2E_REQUIRED=1 but <why>` when it is false in CI.
 */
export function requireInCi(env: Env, ok: boolean, why: string): boolean {
  if (!ok && required(env)) throw new Error(`E2E_REQUIRED=1 but ${why}`);
  return ok;
}
