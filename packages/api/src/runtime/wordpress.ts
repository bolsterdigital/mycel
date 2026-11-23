// `mycel wordpress plan|import`: a WordPress export (WXR) into a tenant (brief
// wordpress-import-execution, PR 2). `plan` reads the file and prints the report without a
// database; `import` executes the plan through the registry as the tenant's system principal
// `importer`, so every write passes the same capability, validation and revision path as an
// editor's. The source id → Mycel id table goes to a JSON file next to the export (§ Ontwerpkeuzes
// 7: no table, no migration), and the report lists each item's admin address. Rejected: a
// separate `import-wordpress` binary that builds its own runtime (a second composition of the
// adapters to keep in step with compose.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { systemPrincipal, type Invoker } from '@mycel/core';
import { execute, formatReport, mediaSource, plan, type ImportPlan } from '@mycel/import-wordpress';
import type { PlatformTenant } from '@mycel/db';

export interface WordpressOptions {
  file: string;
  brandTokensFile?: string;
  defaultLocale?: string;
  featuredAsHeader?: boolean;
}

export const planOf = (options: WordpressOptions): ImportPlan =>
  plan(readFileSync(options.file, 'utf8'), {
    ...(options.brandTokensFile && {
      brandTokens: JSON.parse(readFileSync(options.brandTokensFile, 'utf8')) as unknown,
    }),
    ...(options.defaultLocale && { defaultLocale: options.defaultLocale }),
    ...(options.featuredAsHeader !== undefined && { featuredAsHeader: options.featuredAsHeader }),
  });

/** The placeholder of each source entity back to its kind and WordPress id, for the id file. */
function sourceKey(plan: ImportPlan, ref: string): string {
  const media = plan.media.find((m) => m.ref === ref);
  if (media) return `attachment:${media.sourceId}`;
  const person = plan.people.find((p) => p.ref === ref);
  if (person) return `author:${person.sourceLogin}`;
  const section = plan.sections.find((s) => s.ref === ref);
  if (section) return `category:${section.sourceSlug}`;
  const item = plan.items.find((i) => i.ref === ref);
  return item ? `post:${item.sources.map((s) => s.id).join('+')}` : ref;
}

export async function importWordpress(
  deps: { invoker: Invoker; tenant: PlatformTenant },
  options: WordpressOptions & { mediaDir?: string; intoExisting?: boolean }
): Promise<string> {
  const { tenant } = deps;
  const importPlan = planOf(options);
  const principal = systemPrincipal(tenant.id, 'importer', {
    entitlements: tenant.entitlements,
    status: tenant.status,
  });
  const result = await execute(
    importPlan,
    {
      invoker: deps.invoker,
      principal,
      media: mediaSource({
        siteUrl: importPlan.site.url,
        ...(options.mediaDir && { mediaDir: options.mediaDir }),
      }),
    },
    { intoExisting: options.intoExisting ?? false }
  );
  const idFile = `${options.file}.mycel-ids.json`;
  const ids = Object.fromEntries(
    Object.entries(result.ids).map(([ref, id]) => [sourceKey(importPlan, ref), id])
  );
  writeFileSync(
    idFile,
    `${JSON.stringify({ tenant: tenant.slug, importedAt: new Date().toISOString(), ids }, null, 2)}\n`
  );
  const lines = result.items.map(
    (i) =>
      `  ${i.status.padEnd(9)} ${i.type.padEnd(7)} ${i.slug}\t/admin/${tenant.slug}/content/${i.itemId}`
  );
  return [
    formatReport({ ...importPlan, report: result.report }).trimEnd(),
    '',
    `Imported into ${tenant.slug}: ${result.items.length} of ${importPlan.items.length} items`,
    ...lines,
    `Ids written to ${idFile}`,
    '',
  ].join('\n');
}
