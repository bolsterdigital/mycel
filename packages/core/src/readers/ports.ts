// Storage for reader sign-in: the pending links and the sessions of one tenant. Both run inside a
// use case's tenant transaction like any repository. Neither is the tenant's data in the export
// sense: a link lives fifteen minutes and a session twelve hours, on this installation.

import type { ReaderSession, SigninLink } from './model.js';

export interface SigninLinkRepository {
  insert(link: SigninLink): Promise<void>;
  get(id: string): Promise<SigninLink | null>;
  /**
   * Use the link once, in one statement: sets `consumedAt` when the row has this token hash, is
   * not consumed and has not expired at `at`, and returns it. Null otherwise, so of two callers
   * with the same token exactly one gets the row.
   */
  consume(id: string, tokenHash: string, at: Date): Promise<SigninLink | null>;
}

export interface ReaderSessionRepository {
  insert(session: ReaderSession): Promise<void>;
  /** The session when it is neither revoked nor expired at `at`. */
  getLive(id: string, at: Date): Promise<ReaderSession | null>;
  /** End one session; false when it was already over or never existed. */
  revoke(id: string, at: Date): Promise<boolean>;
}

declare module '../ports.js' {
  interface TransactionContext {
    signinLinks: SigninLinkRepository;
    readerSessions: ReaderSessionRepository;
  }
}
