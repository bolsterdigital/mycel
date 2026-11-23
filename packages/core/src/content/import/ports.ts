// The stored side of a site import (0088) and the planner that reads an export. The planner is a
// port because the core may not know WordPress (ADR 001): the composition wires
// `@mycel/import-wordpress`; suites pass their own. Without one, an upload is refused as
// unavailable, like the assist and Mailchimp ports.

import type { ContentImportRecord, ImportSummary } from './model.js';

export interface ContentImportRepository {
  /** A new planned import with its file. Earlier planned imports, never started, are dropped. */
  insert(record: ContentImportRecord, source: Uint8Array): Promise<void>;
  get(id: string): Promise<ContentImportRecord | null>;
  /** Newest first. */
  list(limit: number): Promise<ContentImportRecord[]>;
  /** Store a new status and its fields; `clearSource` drops the file. */
  update(record: ContentImportRecord, options?: { clearSource?: boolean }): Promise<void>;
  /** The uploaded file, while the row still holds it. */
  source(id: string): Promise<Uint8Array | null>;
  /** False when there was no such import. */
  delete(id: string): Promise<boolean>;
}

/** The export could not be read as a WordPress export. */
export class ImportUnreadable extends Error {}

export interface ImportPlanner {
  /** The dry run of one export; throws `ImportUnreadable` when it is no WordPress export. */
  plan(xml: string, options: { defaultLocale?: string }): ImportSummary;
}

/** Without a planner wired in, an upload is refused rather than silently doing nothing. */
export const unavailablePlanner: ImportPlanner = {
  plan() {
    throw new Error('no import planner is configured');
  },
};

declare module '../../ports.js' {
  interface TransactionContext {
    contentImports: ContentImportRepository;
    importPlanner: ImportPlanner;
  }
}
