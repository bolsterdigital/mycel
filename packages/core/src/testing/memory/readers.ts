// Reader sign-in links and sessions in memory, with the conditions of the Postgres repository:
// `consume` checks and writes in one synchronous step, so of two callers one gets the row.

import type { ReaderSession, SigninLink } from '../../readers/model.js';
import type { ReaderSessionRepository, SigninLinkRepository } from '../../readers/ports.js';
import type { TenantStore } from './store.js';

export function memorySigninLinks(s: TenantStore): SigninLinkRepository {
  return {
    insert: async (link) => void s.signinLinks.set(link.id, { ...link }),
    get: async (id) => {
      const row = s.signinLinks.get(id);
      return row ? { ...row } : null;
    },
    async consume(id, tokenHash, at) {
      const row = s.signinLinks.get(id);
      if (!row || row.tokenHash !== tokenHash || row.consumedAt || row.expiresAt <= at) return null;
      const next: SigninLink = { ...row, consumedAt: new Date(at) };
      s.signinLinks.set(id, next);
      return { ...next };
    },
  };
}

export function memoryReaderSessions(s: TenantStore): ReaderSessionRepository {
  const live = (row: ReaderSession | undefined, at: Date) =>
    row && !row.revokedAt && row.expiresAt > at ? row : null;
  return {
    insert: async (session) => void s.readerSessions.set(session.id, { ...session }),
    getLive: async (id, at) => {
      const row = live(s.readerSessions.get(id), at);
      return row ? { ...row } : null;
    },
    async revoke(id, at) {
      const row = live(s.readerSessions.get(id), at);
      if (!row) return false;
      s.readerSessions.set(id, { ...row, revokedAt: new Date(at) });
      return true;
    },
  };
}
