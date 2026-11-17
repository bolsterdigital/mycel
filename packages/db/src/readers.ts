// Reader sign-in over Postgres (0069): the pending links and the sessions of the tenant in
// context. `consume` is one conditional update, so Postgres decides which of two requests with
// the same link gets the row; `mycel_app` can set `consumed_at` and `revoked_at` and nothing else.

import type { Kysely, Selectable } from 'kysely';
import type {
  ReaderSession,
  ReaderSessionRepository,
  SigninLink,
  SigninLinkRepository,
} from '@mycel/core';
import type { Database } from './infra/schema.js';

type Trx = Kysely<Database>;

export function signinLinkRepository(trx: Trx, tenantId: string): SigninLinkRepository {
  const toLink = (r: Selectable<Database['reader_signin_links']>): SigninLink => ({
    id: r.id,
    email: r.email,
    tokenHash: r.token_hash,
    locale: r.locale,
    returnPath: r.return_path,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
    consumedAt: r.consumed_at ? new Date(r.consumed_at) : null,
  });
  return {
    async insert(link) {
      await trx
        .insertInto('reader_signin_links')
        .values({
          id: link.id,
          tenant_id: tenantId,
          email: link.email,
          token_hash: link.tokenHash,
          locale: link.locale,
          return_path: link.returnPath,
          created_at: link.createdAt,
          expires_at: link.expiresAt,
          consumed_at: link.consumedAt,
        })
        .execute();
    },
    async get(id) {
      const r = await trx
        .selectFrom('reader_signin_links')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return r ? toLink(r) : null;
    },
    async consume(id, tokenHash, at) {
      const r = await trx
        .updateTable('reader_signin_links')
        .set({ consumed_at: at })
        .where('id', '=', id)
        .where('token_hash', '=', tokenHash)
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', at)
        .returningAll()
        .executeTakeFirst();
      return r ? toLink(r) : null;
    },
  };
}

export function readerSessionRepository(trx: Trx, tenantId: string): ReaderSessionRepository {
  const toSession = (r: Selectable<Database['reader_sessions']>): ReaderSession => ({
    id: r.id,
    supporterId: r.supporter_id,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
  });
  return {
    async insert(session) {
      await trx
        .insertInto('reader_sessions')
        .values({
          id: session.id,
          tenant_id: tenantId,
          supporter_id: session.supporterId,
          created_at: session.createdAt,
          expires_at: session.expiresAt,
          revoked_at: session.revokedAt,
        })
        .execute();
    },
    async getLive(id, at) {
      const r = await trx
        .selectFrom('reader_sessions')
        .selectAll()
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', at)
        .executeTakeFirst();
      return r ? toSession(r) : null;
    },
    async revoke(id, at) {
      const r = await trx
        .updateTable('reader_sessions')
        .set({ revoked_at: at })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', at)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
  };
}
