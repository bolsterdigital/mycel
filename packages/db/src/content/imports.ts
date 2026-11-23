// Site imports over Postgres (0088, MY-257 PR 3): `ctx.contentImports` in the tenant's
// transaction, as mycel_app under RLS. The summary and outcome are parsed with the core's schemas
// on read, so a row a later version cannot read fails loudly instead of showing half a report.
// The file is read only by `source`; `list` and `get` never select it, so a page of imports does
// not pull megabytes per row. A second queued import hits the partial unique index, which the
// repository turns into the same conflict the use case words.

import type { Kysely, Selectable } from 'kysely';
import {
  ImportOutcome,
  ImportSummary,
  UseCaseError,
  type ContentImportRecord,
  type ContentImportRepository,
} from '@mycel/core';
import type { Database } from '../infra/schema.js';

const COLUMNS = [
  'id',
  'file_name',
  'status',
  'into_existing',
  'summary',
  'outcome',
  'error',
  'created_at',
  'started_at',
  'finished_at',
] as const;

type Row = Pick<Selectable<Database['content_imports']>, (typeof COLUMNS)[number]>;

const date = (d: Date | string | null) => (d === null ? null : new Date(d));

const toRecord = (r: Row): ContentImportRecord => ({
  id: r.id,
  fileName: r.file_name,
  status: r.status,
  intoExisting: r.into_existing,
  summary: ImportSummary.parse(r.summary),
  outcome: r.outcome === null ? null : ImportOutcome.parse(r.outcome),
  error: r.error,
  createdAt: new Date(r.created_at),
  startedAt: date(r.started_at),
  finishedAt: date(r.finished_at),
});

const busy = (e: unknown) => {
  const pg = e as { code?: string; constraint?: string };
  return pg.code === '23505' && pg.constraint === 'content_imports_active';
};

export function contentImportRepository(
  trx: Kysely<Database>,
  tenantId: string
): ContentImportRepository {
  return {
    async insert(r, source) {
      await trx.deleteFrom('content_imports').where('status', '=', 'planned').execute();
      await trx
        .insertInto('content_imports')
        .values({
          id: r.id,
          tenant_id: tenantId,
          file_name: r.fileName,
          source: Buffer.from(source),
          status: r.status,
          into_existing: r.intoExisting,
          summary: JSON.stringify(r.summary),
          outcome: r.outcome === null ? null : JSON.stringify(r.outcome),
          error: r.error,
          created_at: r.createdAt,
          started_at: r.startedAt,
          finished_at: r.finishedAt,
        })
        .execute();
    },
    async get(id) {
      const row = await trx
        .selectFrom('content_imports')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? toRecord(row) : null;
    },
    async list(limit) {
      const rows = await trx
        .selectFrom('content_imports')
        .select(COLUMNS)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(toRecord);
    },
    async update(r, options) {
      try {
        await trx
          .updateTable('content_imports')
          .set({
            status: r.status,
            outcome: r.outcome === null ? null : JSON.stringify(r.outcome),
            error: r.error,
            started_at: r.startedAt,
            finished_at: r.finishedAt,
            ...(options?.clearSource && { source: null }),
          })
          .where('id', '=', r.id)
          .execute();
      } catch (e) {
        if (busy(e)) throw new UseCaseError('conflict', 'another import of this site is running');
        throw e;
      }
    },
    async source(id) {
      const row = await trx
        .selectFrom('content_imports')
        .select('source')
        .where('id', '=', id)
        .executeTakeFirst();
      return row?.source ? new Uint8Array(row.source) : null;
    },
    async delete(id) {
      const gone = await trx.deleteFrom('content_imports').where('id', '=', id).executeTakeFirst();
      return Number(gone.numDeletedRows) > 0;
    },
  };
}
