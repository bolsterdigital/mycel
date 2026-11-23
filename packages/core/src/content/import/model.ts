// A site import from the admin (MY-257 PR 3, brief wordpress-import-execution § PR 3): an
// administrator uploads a WordPress export, reads the report of the dry run, and starts the run,
// which the `content.import` job carries out in the background. The shapes here are neutral: the
// core does not know WordPress (ADR 001); the planner port reads the file and the job executes
// it with `@mycel/import-wordpress`, and both hand back this summary and these lines.
//
// The uploaded file holds the source site's users and their addresses, so it lives only as long
// as it is needed: on the row (`content_imports.source`, 0088) until the run finishes or the
// import is deleted, never in the blob store, where an orphan would outlive its row. Rejected: a
// file under `imports/` in the blob store (a second lifetime to keep in step with the row, and
// a copy the backup of the store keeps after the row is gone).

import { z } from 'zod';

export const ImportStatus = z.enum(['planned', 'queued', 'running', 'done', 'failed']);
export type ImportStatus = z.infer<typeof ImportStatus>;

/** The largest export an administrator may upload, as for a media file. */
export const IMPORT_MAX_BYTES = 25 * 1024 * 1024;

/** At most this many report lines are kept per import; the rest are counted, not listed. */
export const IMPORT_MAX_LINES = 5000;

/** At most this many earlier imports on the page and in `content.import.list`. */
export const IMPORT_LIST_LIMIT = 20;

/** Rows older than this are deleted by `retention.apply`: the report names people. */
export const IMPORT_RETENTION_DAYS = 30;

/** At most this much of a failure's (scrubbed) message is kept on the row. */
export const IMPORT_ERROR_LENGTH = 1000;

/** One remark of the importer: what was left out or changed, and where. */
export const ImportLine = z
  .object({
    code: z
      .string()
      .max(60)
      .regex(/^[a-z]+(\.[a-z-]+)+$/),
    postId: z.number().int().nonnegative().optional(),
    title: z.string().max(500).optional(),
    locale: z.string().max(35).optional(),
    block: z.string().max(200).optional(),
    position: z.number().int().nonnegative().optional(),
    detail: z.string().max(1000).optional(),
  })
  .strict();
export type ImportLine = z.infer<typeof ImportLine>;

const Count = z.number().int().nonnegative();

/** What the dry run found: the source site, counts per kind and the remarks. */
export const ImportSummary = z
  .object({
    site: z.object({ title: z.string().max(500), url: z.string().max(2000) }).strict(),
    defaultLocale: z.string().max(35),
    locales: z.array(z.string().max(35)).max(50),
    counts: z
      .object({
        pages: Count,
        pagesDraft: Count,
        articles: Count,
        articlesDraft: Count,
        media: Count,
        people: Count,
        groups: Count,
        sections: Count,
        campaigns: Count,
      })
      .strict(),
    lines: z.array(ImportLine).max(IMPORT_MAX_LINES),
    /** Lines beyond `IMPORT_MAX_LINES`, not kept. */
    moreLines: Count,
  })
  .strict();
export type ImportSummary = z.infer<typeof ImportSummary>;

export const ImportedItem = z
  .object({
    itemId: z.string().guid(),
    type: z.string().max(40),
    slug: z.string().max(200),
    status: z.enum(['published', 'draft']),
  })
  .strict();

/** What the run did: the items it made and every remark, the dry run's included. */
export const ImportOutcome = z
  .object({
    items: z.array(ImportedItem).max(IMPORT_MAX_LINES),
    lines: z.array(ImportLine).max(IMPORT_MAX_LINES),
    moreLines: Count,
  })
  .strict();
export type ImportOutcome = z.infer<typeof ImportOutcome>;

/** A row of `content_imports` (0088) without its file. */
export interface ContentImportRecord {
  id: string;
  fileName: string;
  status: ImportStatus;
  /** Import even when the site already has content (brief § Ontwerpkeuzes 7). */
  intoExisting: boolean;
  summary: ImportSummary;
  outcome: ImportOutcome | null;
  /** Scrubbed when written. */
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Which status may follow which. A run is never repeated: a failed import is uploaded anew. */
export const IMPORT_TRANSITIONS = {
  planned: ['queued'],
  queued: ['running', 'failed'],
  running: ['done', 'failed'],
  done: [],
  failed: [],
} as const satisfies Record<ImportStatus, readonly ImportStatus[]>;

export const canMoveImport = (from: ImportStatus, to: ImportStatus): boolean =>
  (IMPORT_TRANSITIONS[from] as readonly ImportStatus[]).includes(to);

/** At most one import per site is queued or running (0088's partial unique index). */
export const isActiveImport = (status: ImportStatus): boolean =>
  status === 'queued' || status === 'running';

/** Cut a list of remarks to what a row keeps. */
export function keptLines(lines: readonly ImportLine[]): { lines: ImportLine[]; moreLines: number } {
  return {
    lines: lines.slice(0, IMPORT_MAX_LINES),
    moreLines: Math.max(0, lines.length - IMPORT_MAX_LINES),
  };
}

export const ImportView = z.object({
  id: z.string().guid(),
  fileName: z.string(),
  status: ImportStatus,
  intoExisting: z.boolean(),
  summary: ImportSummary,
  outcome: ImportOutcome.nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});
export type ImportView = z.infer<typeof ImportView>;

export const toImportView = (r: ContentImportRecord): ImportView => ({
  id: r.id,
  fileName: r.fileName,
  status: r.status,
  intoExisting: r.intoExisting,
  summary: r.summary,
  outcome: r.outcome,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  startedAt: r.startedAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
});
