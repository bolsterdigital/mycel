// Kysely implementations of the form and submission ports. Each takes the transaction handle that
// `withTenant` opened, so every query runs under the tenant's RLS context. Rows carry tenant_id
// explicitly on insert; the policy's WITH CHECK rejects any mismatch.

import { type Kysely } from 'kysely';
import { FormDefinition, type FormRepository, type SubmissionRepository } from '@mycel/core';
import type { Database } from './infra/schema.js';

type Trx = Kysely<Database>;

export function formRepository(trx: Trx, tenantId: string): FormRepository {
  return {
    async findById(id) {
      const row = await trx
        .selectFrom('forms')
        .select('definition')
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? FormDefinition.parse(row.definition) : null;
    },
    async insert(form) {
      await trx
        .insertInto('forms')
        .values({ id: form.id, tenant_id: tenantId, definition: JSON.stringify(form) })
        .execute();
    },
  };
}

export function submissionRepository(trx: Trx, tenantId: string): SubmissionRepository {
  return {
    async insert(s) {
      await trx
        .insertInto('form_submissions')
        .values({
          id: s.id,
          tenant_id: tenantId,
          form_id: s.formId,
          values: JSON.stringify(s.values),
          locale: s.locale,
          page_url: s.pageUrl,
          ip_hash: s.ipHash,
          created_at: s.createdAt,
          confirmed_at: s.confirmedAt,
          list: s.list,
          consent_text_version: s.consentTextVersion,
        })
        .execute();
    },
    async findById(id) {
      const row = await trx
        .selectFrom('form_submissions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        formId: row.form_id,
        values: row.values,
        locale: row.locale,
        pageUrl: row.page_url,
        ipHash: row.ip_hash,
        createdAt: new Date(row.created_at),
        confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
        list: row.list,
        consentTextVersion: row.consent_text_version,
      };
    },
    async confirm(id, at) {
      // One conditional update: the first click sets it, every later click matches no row.
      const row = await trx
        .updateTable('form_submissions')
        .set({ confirmed_at: at })
        .where('id', '=', id)
        .where('confirmed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
