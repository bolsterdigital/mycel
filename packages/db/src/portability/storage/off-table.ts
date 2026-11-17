// The storage catalog of what is kept outside the tables: blobs, export archives, backups and
// copies at a provider. Same fields as `STORAGE` in `../storage.ts`, which holds the
// rules of the catalog and re-exports this one. Apart so that file stays under its size ceiling;
// storage.test.ts reads both catalogs, so nothing is checked less.
// Rejected: a size allowance for storage.ts (the gate asks for a subject in a file of its own).

import type { StorageEntry } from '../storage.js';

/** What is kept outside the tables, with the same fields; `where` says where it lives. */
export interface OffTableStorage extends Omit<StorageEntry, 'category'> {
  where: string;
}

export const OFF_TABLE_STORAGE = {
  'media originals': {
    where: 'the blob store, key per asset (media.ts)',
    owner: 'tenant',
    copies: [
      {
        field: 'pixels',
        subject: 'person',
        route: {
          kind: 'use-case',
          useCases: ['media.delete'],
          does: 'a face is not found from a person id, and a shared image may show others (ADR 034 rule 3); the tenant deletes the asset',
        },
      },
      {
        // An image is re-encoded with stripMetadata (media/service.ts), so EXIF and location are
        // gone before it is stored; a PDF is stored as uploaded, its author field included.
        field: 'metadata',
        subject: 'anyone',
        route: {
          kind: 'use-case',
          useCases: ['media.delete'],
          does: 'a PDF keeps its document metadata until the tenant deletes it',
        },
      },
    ],
    retention: {
      kind: 'term',
      term: 'with the row; a file without a row after a day',
      by: 'media.orphans',
    },
  },
  'media variants': {
    where: 'the blob store, beside each original (variants column)',
    owner: 'tenant',
    copies: [
      {
        field: 'pixels',
        subject: 'person',
        route: { kind: 'use-case', useCases: ['media.delete'], does: 'goes with the original' },
      },
    ],
    retention: { kind: 'term', term: 'with the original', by: 'media.orphans' },
  },
  'export archives': {
    where: 'the blob store, exports/<tenant>/<id>.tar per tenant_exports row',
    owner: 'tenant',
    copies: [
      {
        field: 'archive',
        subject: 'supporter',
        route: {
          kind: 'apply',
          does: 'expires every archive that may hold an erased person; the job deletes the file',
        },
      },
      {
        field: 'archive',
        subject: 'person',
        route: {
          kind: 'apply',
          does: 'expires every archive asked for before a person registration, or all when apply changed anything',
        },
      },
      {
        // A membership line names the member by address (ADR 035 rule 5).
        field: 'archive',
        subject: 'operator',
        route: {
          kind: 'platform',
          operations: ['platform.operator.erase'],
          does: 'expires every archive of a tenant where the erased operator held a membership',
        },
      },
    ],
    retention: {
      kind: 'term',
      term: '7 days (EXPORT_RETENTION_DAYS)',
      by: 'tenant.export.expire',
    },
  },
  'database snapshots': {
    where: 'restic repository, tag mycel,db (docker/backup/backup.sh)',
    owner: 'installation',
    copies: [
      {
        field: 'snapshot',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason:
            'a snapshot is not rewritten; a restore re-applies the register before serving (ADR 019 rule 8)',
        },
      },
      {
        field: 'snapshot',
        subject: 'person',
        route: {
          kind: 'excluded',
          reason:
            'a snapshot is not rewritten; a restore re-applies the person register before serving (ADR 034 rule 2)',
        },
      },
      {
        field: 'snapshot',
        subject: 'operator',
        route: {
          kind: 'excluded',
          reason:
            'a snapshot is not rewritten; a restore erases every registered operator again before serving (ADR 035 rule 2)',
        },
      },
    ],
    retention: {
      kind: 'term',
      term: 'keep-daily 14, keep-weekly 8, keep-monthly 6 (BACKUP_KEEP_*)',
      by: 'docker/backup/backup.sh',
    },
  },
  'erasure register snapshots': {
    where: 'restic repository, tag mycel,erasures (docker/backup/backup.sh)',
    owner: 'installation',
    copies: [
      {
        field: 'snapshot',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason: 'hashes and ids only; it is what a restore re-applies',
        },
      },
      {
        field: 'snapshot',
        subject: 'person',
        route: {
          kind: 'excluded',
          reason: 'person ids only; the person register a restore re-applies (ADR 034 rule 2)',
        },
      },
      {
        field: 'snapshot',
        subject: 'operator',
        route: {
          kind: 'excluded',
          reason: 'operator ids only; the operator register a restore re-applies (ADR 035 rule 2)',
        },
      },
    ],
    retention: {
      kind: 'term',
      term: 'keep-last 48, keep-daily 14 (ERASURES_KEEP_*)',
      by: 'docker/backup/backup.sh',
    },
  },
  'provider copies': {
    where: 'an external CRM, ESP or mail provider (ADR 024)',
    owner: 'tenant',
    copies: [
      {
        field: 'contact',
        subject: 'supporter',
        route: {
          kind: 'excluded',
          reason:
            'a separate copy with its own owner; apply detaches and blocks, it never claims the provider deleted (ADR 024)',
        },
      },
    ],
    retention: { kind: 'kept', why: 'owned by the provider account, reconciled per connection' },
  },
} as const satisfies Record<string, OffTableStorage>;
