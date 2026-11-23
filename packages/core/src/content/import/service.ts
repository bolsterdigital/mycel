// Importing a site from the admin (MY-257 PR 3). Three commands and a query, all `tenant:admin`:
// the run writes pages, people, media and campaigns as the tenant's `importer`, so whoever starts
// it must already be allowed all of that.
//
// - `content.import.upload` reads the export through the planner (the dry run), stores the file
//   and its summary as a `planned` import, and drops earlier planned ones. Nothing else changes.
// - `content.import.confirm` turns a planned import into a `queued` one and plans the
//   `content.import` job; one import per site runs at a time.
// - `content.import.delete` removes a finished or planned import with its report and its file.
// - `content.import.list` shows them, newest first.
//
// The job side (`claimImport`, `finishImport`) runs in packages/api with the importer: the run
// spans many units of work, one per use case, so it cannot be one handler in one transaction. A
// run is never repeated: when the worker finds its import already `running` (the worker died
// half way), it fails the import instead of importing a second copy of what came over.
// Rejected: a run inside the request (minutes for a real site) and a retry that imports again
// (duplicates; the clean-cut rule of the brief says upload anew into a fresh site).

import { z } from 'zod';
import { UseCaseError, notFound } from '../../errors.js';
import { Locale } from '../../i18n/locale.js';
import { jobKey } from '../../jobs/types.js';
import '../../jobs/ports.js';
import type { TransactionContext } from '../../ports.js';
import { defineUseCase } from '../../registry.js';
import { base64ToBytes } from '../../util/bytes.js';
import { errorMessage } from '../../util/log.js';
import { scrubText } from '../../util/scrub.js';
import {
  IMPORT_ERROR_LENGTH,
  IMPORT_LIST_LIMIT,
  IMPORT_MAX_BYTES,
  ImportStatus,
  ImportView,
  canMoveImport,
  isActiveImport,
  toImportView,
  type ContentImportRecord,
  type ImportOutcome,
} from './model.js';
import { ImportUnreadable } from './ports.js';
import './ports.js';

const MAX_BASE64 = Math.ceil(IMPORT_MAX_BYTES / 3) * 4;

const invalid = (path: string, message: string, detail: string) =>
  new UseCaseError('invalid_input', detail, [{ path, message }]);

const FileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f/\\]+$/, 'import.file.name');

export const uploadImport = defineUseCase({
  name: 'content.import.upload',
  kind: 'command',
  description:
    'Upload a WordPress export (WXR, up to 25 MB, base64) and get the report of a dry run: what would be made and what would be left out or changed. Nothing is imported until `content.import.confirm`. An earlier upload that was never started is replaced.',
  requires: 'tenant:admin',
  // A dry run makes nothing that counts against a limit; the run itself goes through use cases
  // that do (`media.upload`, `content.item.create`).
  consumes: null,
  input: z
    .object({
      fileName: FileName,
      bytes: z
        .string()
        .min(1, 'import.file.empty')
        .max(MAX_BASE64, 'import.file.too-large')
        .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'import.file.base64'),
      /** The language of the source site; else the export's own (Polylang, then the channel). */
      defaultLocale: Locale.optional(),
      intoExisting: z.boolean().default(false),
    })
    .strict(),
  output: ImportView,
  examples: [
    {
      input: { fileName: 'export.xml', bytes: 'PHJzcy8+', intoExisting: false },
      note: 'A tiny file; a real export is the XML of Tools → Export in WordPress.',
    },
  ],
  async handler(ctx, input) {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(input.bytes);
    } catch {
      throw invalid('bytes', 'import.file.base64', 'bytes is not valid base64');
    }
    if (bytes.length > IMPORT_MAX_BYTES)
      throw invalid('bytes', 'import.file.too-large', 'the file is larger than 25 MB');
    let summary;
    try {
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      summary = ctx.importPlanner.plan(xml, {
        ...(input.defaultLocale && { defaultLocale: input.defaultLocale }),
      });
    } catch (error) {
      if (error instanceof ImportUnreadable || error instanceof TypeError)
        throw invalid('bytes', 'import.file.unreadable', 'the file is not a WordPress export');
      throw error;
    }
    const record: ContentImportRecord = {
      id: ctx.ids.next(),
      fileName: input.fileName,
      status: 'planned',
      intoExisting: input.intoExisting,
      summary,
      outcome: null,
      error: null,
      createdAt: ctx.clock.now(),
      startedAt: null,
      finishedAt: null,
    };
    await ctx.contentImports.insert(record, bytes);
    return toImportView(record);
  },
});

export const confirmImport = defineUseCase({
  name: 'content.import.confirm',
  kind: 'command',
  description:
    'Start a planned import: it runs in the background, creating media, people, sections, pages, articles and campaigns through the ordinary use cases, and its report says what was made. Only one import runs at a time per site.',
  requires: 'tenant:admin',
  input: z.object({ importId: z.string().guid() }).strict(),
  output: z.object({ id: z.string().guid(), status: ImportStatus }),
  examples: [{ input: { importId: '01890a5d-ac96-774b-bcce-b302099a8057' } }],
  async handler(ctx, { importId }) {
    const record = await ctx.contentImports.get(importId);
    if (!record) throw notFound('import');
    if (record.status !== 'planned')
      throw new UseCaseError('conflict', `this import is ${record.status}, not planned`, [
        { path: 'importId', message: 'import.state.not-planned' },
      ]);
    const running = (await ctx.contentImports.list(IMPORT_LIST_LIMIT)).some((r) =>
      isActiveImport(r.status)
    );
    if (running)
      throw new UseCaseError('conflict', 'another import of this site is running', [
        { path: 'importId', message: 'import.state.busy' },
      ]);
    const queued = { ...record, status: 'queued' as const };
    await ctx.contentImports.update(queued);
    await ctx.jobs.enqueue({
      type: 'content.import',
      key: jobKey('content.import', importId),
      runAt: ctx.clock.now(),
      payload: { importId },
    });
    return { id: importId, status: queued.status };
  },
});

export const deleteImport = defineUseCase({
  name: 'content.import.delete',
  kind: 'command',
  description:
    'Delete an import that is planned or finished, with its report and its uploaded file. What it imported stays; a running import cannot be deleted.',
  requires: 'tenant:admin',
  input: z.object({ importId: z.string().guid() }).strict(),
  output: z.object({ deleted: z.literal(true) }),
  examples: [{ input: { importId: '01890a5d-ac96-774b-bcce-b302099a8057' } }],
  async handler(ctx, { importId }) {
    const record = await ctx.contentImports.get(importId);
    if (!record) throw notFound('import');
    if (isActiveImport(record.status))
      throw new UseCaseError('conflict', 'this import is running', [
        { path: 'importId', message: 'import.state.busy' },
      ]);
    await ctx.contentImports.delete(importId);
    return { deleted: true as const };
  },
});

export const listImports = defineUseCase({
  name: 'content.import.list',
  kind: 'query',
  description:
    'List the imports of this site, newest first: the file, its status, the report of the dry run and, once it ran, what was made.',
  requires: 'tenant:admin',
  input: z.object({}).strict(),
  output: z.object({ imports: z.array(ImportView) }),
  examples: [{ input: {} }],
  async handler(ctx) {
    return {
      imports: (await ctx.contentImports.list(IMPORT_LIST_LIMIT)).map(toImportView),
    };
  },
});

/** What the job may do with the import it was given. */
export type ImportClaim =
  | { kind: 'start'; record: ContentImportRecord; xml: string }
  | { kind: 'gone' };

function move(record: ContentImportRecord, to: ImportStatus, fields: Partial<ContentImportRecord>) {
  if (!canMoveImport(record.status, to))
    throw new Error(`content.import: ${record.status} cannot become ${to}`);
  return { ...record, ...fields, status: to };
}

/** The failure a row keeps: scrubbed (an exception may quote an address) and cut. */
export const importFailure = (e: unknown): string =>
  scrubText(errorMessage(e)).slice(0, IMPORT_ERROR_LENGTH);

/** The message of a run that was interrupted: what came over stays, nothing is imported twice. */
export const IMPORT_INTERRUPTED = 'the run was interrupted; what came over stays, upload anew to repeat';

/**
 * In the job's unit of work: start a queued import, or fail one a dead run left `running` (and
 * drop its file). Anything else is gone: deleted, planned again, or finished.
 */
export async function claimImport(ctx: TransactionContext, importId: string): Promise<ImportClaim> {
  const record = await ctx.contentImports.get(importId);
  if (!record) return { kind: 'gone' };
  const now = ctx.clock.now();
  if (record.status === 'running') {
    await ctx.contentImports.update(
      move(record, 'failed', { finishedAt: now, error: IMPORT_INTERRUPTED }),
      { clearSource: true }
    );
    return { kind: 'gone' };
  }
  if (record.status !== 'queued') return { kind: 'gone' };
  const source = await ctx.contentImports.source(importId);
  const started = move(record, 'running', { startedAt: now });
  if (!source) {
    await ctx.contentImports.update(
      move(started, 'failed', { finishedAt: now, error: 'the uploaded file is gone' })
    );
    return { kind: 'gone' };
  }
  await ctx.contentImports.update(started);
  return { kind: 'start', record: started, xml: new TextDecoder().decode(source) };
}

/** In a unit of work after the run: its outcome, or its failure; the file goes either way. */
export async function finishImport(
  ctx: TransactionContext,
  importId: string,
  result: { outcome: ImportOutcome } | { error: string }
): Promise<void> {
  const record = await ctx.contentImports.get(importId);
  if (!record || record.status !== 'running') return;
  const now = ctx.clock.now();
  const next =
    'outcome' in result
      ? move(record, 'done', { finishedAt: now, outcome: result.outcome })
      : move(record, 'failed', { finishedAt: now, error: result.error });
  await ctx.contentImports.update(next, { clearSource: true });
}
