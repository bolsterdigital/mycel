// People exist without a public page. One pure decision is shared by later routes, links and
// sitemaps; rejected: checking the site switch independently in each renderer.
import { z } from 'zod';
import { localized } from '../../i18n/locale.js';
import type { Person } from '../model.js';

export function personPageStatus(
  site: { personPages?: 'auto' | 'off' },
  person: Pick<Person, 'pagePolicy'>,
  publishedArticleCount: number
): 'enabled' | 'site-off' | 'never' | 'no-articles' {
  if (site.personPages === 'off') return 'site-off';
  if (person.pagePolicy === 'never') return 'never';
  if (person.pagePolicy === 'always' || publishedArticleCount > 0) return 'enabled';
  return 'no-articles';
}

export const PersonGroupInput = z
  .object({
    name: localized(z.string().min(1).max(200)),
    order: z.number().int().min(0).max(10000).default(0),
    personIds: z
      .array(z.string().guid())
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, 'content.authors.duplicate')
      .default([]),
  })
  .strict();
export const PersonGroup = PersonGroupInput.extend({
  id: z.string().guid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PersonGroup = z.infer<typeof PersonGroup>;

export interface PersonGroupRepository {
  get(id: string): Promise<PersonGroup | null>;
  list(offset: number, limit: number): Promise<PersonGroup[]>;
  insert(group: PersonGroup): Promise<void>;
  update(group: PersonGroup, baseUpdatedAt: string): Promise<boolean>;
}
declare module '../../ports.js' {
  interface TransactionContext {
    personGroups: PersonGroupRepository;
  }
}
