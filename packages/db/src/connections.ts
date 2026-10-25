// Tenant inventory and encrypted installation-local credentials (TODO #40 PR 1A). Plaintext is
// accepted only at the write boundary; reads and exports never select it. Rejected: putting the
// credential in the exportable connection row or deriving this key from the audit hash key.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import type {
  ConnectionRecord,
  ConnectionRepository,
  ConnectionChanges,
  NewConnection,
} from '@mycel/core';
import type { Database } from './schema.js';

type Row = Selectable<Database['connections']> & { credential_id: string | null };

function asRecord(r: Row): ConnectionRecord {
  return {
    id: r.id,
    provider: r.provider,
    accountRef: r.account_ref,
    externalOwner: r.external_owner,
    maintainer: r.maintainer,
    purpose: r.purpose,
    direction: r.direction,
    dataAuthority: r.data_authority,
    consentAuthority: r.consent_authority,
    consentScopes: r.consent_scopes,
    formIds: r.form_ids,
    destination: r.destination,
    contractVersion: r.contract_version,
    adapterVersion: r.adapter_version,
    state: r.state,
    version: r.version,
    credentialVersion: r.credential_version,
    hasCredential: r.credential_id !== null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

/** Hex avoids ambiguous base64 padding and makes the 32-byte requirement explicit. */
export function credentialKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error('CONNECTION_CREDENTIAL_KEY must be 32 bytes in hex');
  return Buffer.from(hex, 'hex');
}

const aad = (tenantId: string, connectionId: string, version: number) =>
  Buffer.from(`${tenantId}:${connectionId}:${version}`, 'utf8');

export function encryptCredential(
  secret: string,
  key: Buffer,
  tenantId: string,
  connectionId: string,
  version: number
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(tenantId, connectionId, version));
  const content = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${content.toString('base64')}`;
}

/** For the later worker: authenticated decryption is bound to tenant, connection and version. */
export function decryptCredential(
  encoded: string,
  key: Buffer,
  tenantId: string,
  connectionId: string,
  version: number
): string {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unsupported credential version');
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const content = Buffer.from(parts[3]!, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid credential envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad(tenantId, connectionId, version));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8');
}

function updates(changes: ConnectionChanges): Updateable<Database['connections']> {
  return {
    ...(changes.accountRef !== undefined && { account_ref: changes.accountRef }),
    ...(changes.externalOwner !== undefined && { external_owner: changes.externalOwner }),
    ...(changes.maintainer !== undefined && { maintainer: changes.maintainer }),
    ...(changes.purpose !== undefined && { purpose: changes.purpose }),
    ...(changes.direction !== undefined && { direction: changes.direction }),
    ...(changes.dataAuthority !== undefined && { data_authority: changes.dataAuthority }),
    ...(changes.consentAuthority !== undefined && { consent_authority: changes.consentAuthority }),
    ...(changes.consentScopes !== undefined && {
      consent_scopes: JSON.stringify(changes.consentScopes),
    }),
    ...(changes.formIds !== undefined && { form_ids: changes.formIds }),
    ...(changes.destination !== undefined && { destination: changes.destination }),
    ...(changes.contractVersion !== undefined && { contract_version: changes.contractVersion }),
    ...(changes.adapterVersion !== undefined && { adapter_version: changes.adapterVersion }),
  };
}

export function connectionRepository(
  trx: Kysely<Database>,
  tenantId: string,
  key: Buffer | null,
  validateDestination?: (url: string) => Promise<void>,
  allowCredentialRead = false
): ConnectionRepository {
  const query = () =>
    trx
      .selectFrom('connections as c')
      .leftJoin('connection_credentials as k', (join) =>
        join.onRef('k.connection_id', '=', 'c.id').onRef('k.tenant_id', '=', 'c.tenant_id')
      )
      .selectAll('c')
      .select('k.connection_id as credential_id')
      .where('c.tenant_id', '=', tenantId);
  const get = async (id: string) => {
    const row = await query().where('c.id', '=', id).executeTakeFirst();
    return row ? asRecord(row) : null;
  };
  return {
    get,
    async credential(id, version) {
      if (!key || !allowCredentialRead) return null;
      const row = await trx
        .selectFrom('connection_credentials as k')
        .innerJoin('connections as c', 'c.id', 'k.connection_id')
        .select(['k.ciphertext', 'c.credential_version'])
        .where('k.tenant_id', '=', tenantId)
        .where('c.tenant_id', '=', tenantId)
        .where('c.id', '=', id)
        .where('c.credential_version', '=', version)
        .where('c.state', '=', 'active')
        .executeTakeFirst();
      return row ? decryptCredential(row.ciphertext, key, tenantId, id, version) : null;
    },
    async list() {
      return (await query().orderBy('c.created_at', 'desc').execute()).map(asRecord);
    },
    async insert(record: NewConnection, at: Date) {
      if (record.provider === 'webhook' && record.destination && validateDestination)
        await validateDestination(record.destination);
      await trx
        .insertInto('connections')
        .values({
          id: record.id,
          tenant_id: tenantId,
          provider: record.provider,
          account_ref: record.accountRef,
          external_owner: record.externalOwner,
          maintainer: record.maintainer,
          purpose: record.purpose,
          direction: record.direction,
          data_authority: record.dataAuthority,
          consent_authority: record.consentAuthority,
          consent_scopes: JSON.stringify(record.consentScopes),
          form_ids: record.formIds,
          destination: record.destination,
          contract_version: record.contractVersion,
          adapter_version: record.adapterVersion,
          state: 'paused',
          version: 1,
          credential_version: 0,
          created_at: at,
          updated_at: at,
        })
        .execute();
      return (await get(record.id))!;
    },
    async update(id, baseVersion, changes, at) {
      if (changes.destination && validateDestination)
        await validateDestination(changes.destination);
      const row = await trx
        .updateTable('connections')
        .set({ ...updates(changes), version: sql`version + 1`, updated_at: at })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .where('version', '=', baseVersion)
        .where('state', '!=', 'disconnected')
        .returning('id')
        .executeTakeFirst();
      return row ? get(id) : null;
    },
    async state(id, baseVersion, state, at) {
      const row = await trx
        .updateTable('connections')
        .set({ state, version: sql`version + 1`, updated_at: at })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .where('version', '=', baseVersion)
        .where('state', '!=', 'disconnected')
        .returning('id')
        .executeTakeFirst();
      if (!row) return null;
      if (state === 'disconnected')
        await trx
          .deleteFrom('connection_credentials')
          .where('tenant_id', '=', tenantId)
          .where('connection_id', '=', id)
          .execute();
      return get(id);
    },
    async replaceCredential(id, baseVersion, secret, at) {
      if (!key) throw new Error('connection credential encryption is not configured');
      const row = await trx
        .updateTable('connections')
        .set({
          version: sql`version + 1`,
          credential_version: sql`credential_version + 1`,
          updated_at: at,
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .where('version', '=', baseVersion)
        .where('state', '!=', 'disconnected')
        .returning(['id', 'credential_version'])
        .executeTakeFirst();
      if (!row) return null;
      const ciphertext = encryptCredential(secret, key, tenantId, id, row.credential_version);
      await trx
        .insertInto('connection_credentials')
        .values({
          connection_id: id,
          tenant_id: tenantId,
          ciphertext,
          updated_at: at,
        })
        .onConflict((oc) => oc.column('connection_id').doUpdateSet({ ciphertext, updated_at: at }))
        .execute();
      return get(id);
    },
  };
}
