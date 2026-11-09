// Kysely implementations of the form and submission ports. Each takes the transaction handle that
// `withTenant` opened, so every query runs under the tenant's RLS context. Rows carry tenant_id
// explicitly on insert; the policy's WITH CHECK rejects any mismatch.

import { sql, type Kysely } from 'kysely';
import {
  FormMailSettings,
  EMPTY_FORM_MAIL,
  parseFormDefinition,
  type FormRepository,
  type SubmissionRepository,
} from '@mycel/core';
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
      return row ? parseFormDefinition(row.definition) : null;
    },
    async insert(form) {
      await trx
        .insertInto('forms')
        .values({
          id: form.id,
          tenant_id: tenantId,
          definition: JSON.stringify(parseFormDefinition(form)),
        })
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
          evaluation: s.evaluation ? JSON.stringify(s.evaluation) : null,
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
        evaluation: row.evaluation,
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

export function formMailRepository(
  trx: Trx,
  tenantId: string
): import('@mycel/core').FormMailRepository {
  return {
    async get() {
      const row = await trx
        .selectFrom('form_mail_settings')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      return row
        ? { version: row.version, value: FormMailSettings.parse(row.value) }
        : structuredClone(EMPTY_FORM_MAIL);
    },
    async save(baseVersion, value) {
      const change = { version: baseVersion + 1, value: JSON.stringify(value) };
      const row =
        baseVersion === 0
          ? await trx
              .insertInto('form_mail_settings')
              .values({ tenant_id: tenantId, ...change })
              .onConflict((oc) => oc.column('tenant_id').doNothing())
              .returning('version')
              .executeTakeFirst()
          : await trx
              .updateTable('form_mail_settings')
              .set(change)
              .where('tenant_id', '=', tenantId)
              .where('version', '=', baseVersion)
              .returning('version')
              .executeTakeFirst();
      return row ? { version: row.version, value } : null;
    },
    async reserveBudget(month, count, max) {
      if (count > max) return false;
      const row = await trx
        .insertInto('form_mail_budget')
        .values({ tenant_id: tenantId, month, used: count })
        .onConflict((oc) =>
          oc
            .column('tenant_id')
            .doUpdateSet({
              month,
              used: sql`case when form_mail_budget.month = ${month} then form_mail_budget.used + ${count} else ${count} end`,
            })
            .where(
              sql<boolean>`form_mail_budget.month <> ${month} or form_mail_budget.used + ${count} <= ${max}`
            )
        )
        .returning('used')
        .executeTakeFirst();
      return !!row;
    },
  };
}
