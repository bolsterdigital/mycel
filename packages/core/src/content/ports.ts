import type { Page } from './model.js';

export interface PageRepository {
  findBySlug(slug: string): Promise<Page | null>;
  insert(page: Page): Promise<void>;
}

declare module '../ports.js' {
  interface TransactionContext {
    pages: PageRepository;
  }
}
