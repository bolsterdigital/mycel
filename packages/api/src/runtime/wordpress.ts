// `mycel wordpress plan|import`: a WordPress export (WXR) into a tenant (brief
// wordpress-import-execution, PR 2). `plan` reads the file and prints the report without a
// database; `import` executes the plan through the registry as the tenant's system principal
// `importer`, so every write passes the same capability, validation and revision path as an
// editor's. The source id → Mycel id table goes to a JSON file next to the export (§ Ontwerpkeuzes
// 7: no table, no migration), and the report lists each item's admin address. Rejected: a
// separate `import-wordpress` binary that builds its own runtime (a second composition of the
// adapters to keep in step with compose.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import {
  ImportUnreadable,
  checkDestination,
  claimImport,
  finishImport,
  importFailure,
  keptLines,
  systemPrincipal,
  type DnsResolver,
  type IdentityStore,
  type ImportPlanner,
  type ImportSummary,
  type Invoker,
  type UnitOfWork,
} from '@mycel/core';
import { execute, formatReport, mediaSource, plan, type ImportPlan } from '@mycel/import-wordpress';
import type { PlatformTenant } from '@mycel/db';

export interface WordpressOptions {
  file: string;
  defaultLocale?: string;
  featuredAsHeader?: boolean;
}

export const planOf = (options: WordpressOptions): ImportPlan =>
  plan(readFileSync(options.file, 'utf8'), {
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

// The admin's import (MY-257 PR 3): the same plan and run as the CLI, with two differences. The
// file comes from an administrator instead of the operator's disk, so the site address in it is
// theirs to choose: a download goes only to a public address over https, pinned to the DNS answer
// that was checked (`publicFetch`, the webhook rule of ADR 024 rule 6), on top of the importer's
// own "only the export's host" rule. And the result goes to the import's row instead of a file.

/** The counts and remarks of a plan, as the core keeps them. */
export function summaryOf(p: ImportPlan): ImportSummary {
  const items = (type: string, draft = false) =>
    p.items.filter((i) => i.document.type === type && (!draft || i.status === 'draft')).length;
  return {
    site: { title: p.site.title.slice(0, 500), url: p.site.url.slice(0, 2000) },
    defaultLocale: p.defaultLocale,
    locales: p.locales.slice(0, 50),
    counts: {
      pages: items('page'),
      pagesDraft: items('page', true),
      articles: items('article'),
      articlesDraft: items('article', true),
      media: p.media.length,
      people: p.people.length,
      groups: p.groups.length,
      sections: p.sections.length,
      campaigns: p.campaigns.length,
    },
    ...keptLines(p.report.map(lineOf)),
  };
}

/** A report line within the core's bounds: a long title or detail is cut, never refused. */
function lineOf(l: ImportPlan['report'][number]) {
  return {
    code: l.code,
    ...(l.postId !== undefined && { postId: l.postId }),
    ...(l.title !== undefined && { title: l.title.slice(0, 500) }),
    ...(l.locale !== undefined && { locale: l.locale.slice(0, 35) }),
    ...(l.block !== undefined && { block: l.block.slice(0, 200) }),
    ...(l.position !== undefined && { position: l.position }),
    ...(l.detail !== undefined && { detail: l.detail.slice(0, 1000) }),
  };
}

const planWordpress = (xml: string, defaultLocale?: string): ImportPlan => {
  try {
    return plan(xml, defaultLocale ? { defaultLocale } : {});
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('not a WordPress export'))
      throw new ImportUnreadable(error.message);
    throw error;
  }
};

/** The planner `content.import.upload` asks for its dry run. */
export const wordpressPlanner: ImportPlanner = {
  plan: (xml, { defaultLocale }) => summaryOf(planWordpress(xml, defaultLocale)),
};

const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * A GET for `mediaSource` that reaches only a public address: the URL passes `checkDestination`
 * (https on 443, no IP literal, every DNS answer public) and the request goes to the checked
 * address, so a second lookup cannot point it elsewhere. No redirect is followed. Rejected:
 * `fetch` after a separate check, whose own resolver can answer differently (DNS rebinding).
 */
export function publicFetch(dns: Pick<DnsResolver, 'addresses'>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let target: Awaited<ReturnType<typeof checkDestination>>;
    try {
      target = await checkDestination(dns, String(input));
    } catch {
      throw new Error(`not a public https address: ${new URL(String(input)).host}`);
    }
    const family = isIP(target.address);
    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        target.url,
        {
          method: 'GET',
          timeout: 30_000,
          ...(init?.signal && { signal: init.signal }),
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [{ address: target.address, family }]);
            else callback(null, target.address, family);
          },
        },
        (res) => {
          const status = res.statusCode ?? 502;
          const body = NO_BODY.has(status)
            ? null
            : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
          if (!body) res.resume();
          resolve(new Response(body, { status }));
        }
      );
      req.on('timeout', () => req.destroy(new Error('the download timed out')));
      req.on('error', reject);
      req.end();
    });
  }) as typeof fetch;
}

export interface ContentImportDeps {
  uow: UnitOfWork;
  invoker: Invoker;
  identity: Pick<IdentityStore, 'tenantAccess'>;
  /** Downloads of the export's media; `publicFetch` in production. */
  fetch: typeof fetch;
}

/**
 * The `content.import` job: claim the import, run the plan through the registry as the tenant's
 * `importer`, and record the outcome or the failure. Every failure lands on the row; the job
 * itself only fails when the database does, and then `claimImport` fails the import on the retry
 * instead of importing twice.
 */
export async function runContentImport(
  deps: ContentImportDeps,
  tenantId: string,
  importId: string
): Promise<void> {
  const access = await deps.identity.tenantAccess(tenantId);
  const principal = systemPrincipal(tenantId, 'importer', access);
  const jobPrincipal = systemPrincipal(tenantId, 'jobs:content.import', access);
  const claim = await deps.uow.run(jobPrincipal, (ctx) => claimImport(ctx, importId));
  if (claim.kind !== 'start') return;
  let result: Parameters<typeof finishImport>[2];
  try {
    const importPlan = planWordpress(claim.xml, claim.record.summary.defaultLocale);
    const run = await execute(
      importPlan,
      {
        invoker: deps.invoker,
        principal,
        media: mediaSource({ siteUrl: importPlan.site.url, fetch: deps.fetch }),
      },
      { intoExisting: claim.record.intoExisting }
    );
    result = {
      outcome: {
        items: run.items.slice(0, 5000).map((i) => ({
          itemId: i.itemId,
          type: i.type,
          slug: i.slug,
          status: i.status,
        })),
        ...keptLines(run.report.map(lineOf)),
      },
    };
  } catch (error) {
    result = { error: importFailure(error) };
  }
  await deps.uow.run(jobPrincipal, (ctx) => finishImport(ctx, importId, result));
}
