// The version of this build, for `mycel version` and `mycel_build_info` (TODO #18b). The release
// image sets MYCEL_VERSION from its build argument (Dockerfile), which a tag can set without
// touching the source; a checkout without it reads the root package.json, which
// `npm run release` bumps. Rejected: baking the version into the compiled output at build time,
// which would make `npm run build` depend on the release step.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Metrics } from './metrics.js';

export function buildVersion(fromImage = process.env['MYCEL_VERSION']): string {
  if (fromImage?.trim()) return fromImage.trim();
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')
  ) as { version: string };
  return pkg.version;
}

/** The one-sample gauge `mycel_build_info{version="…"} 1`, the Prometheus convention. */
export function recordBuildInfo(metrics: Metrics, version = buildVersion()): void {
  metrics.gauge('mycel_build_info', 'Version of the running build').set(1, { version });
}
