// People exist without a public page. One pure decision is shared by later routes, links and
// sitemaps; rejected: checking the site switch independently in each renderer.
import { z } from 'zod';
import { localized } from '../../i18n/locale.js';
import { UseCaseError } from '../../errors.js';
import type { Person } from '../model.js';

export function personPageStatus(
  site: { personPages?: 'auto' | 'off' },
  person: Pick<Person, 'pagePolicy'> & { kind?: Person['kind'] | undefined },
  publishedArticleCount: number
): 'enabled' | 'site-off' | 'never' | 'no-articles' | 'organisation' {
  // An organisation has no profile page, whatever the site or its stored policy says.
  if (person.kind === 'organisation') return 'organisation';
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

/**
 * The fields an organisation does not have: a role, a phone number and a page policy that asks for
 * a profile page. Refused with a readable issue per field rather than silently dropped, so an API
 * caller sees why. Rejected: a discriminated union per kind, which would split `PersonInput` and
 * every `.extend` built on it for three fields.
 */
export function assertOrganisationFields(
  fields: Pick<Person, 'kind' | 'role' | 'phone' | 'pagePolicy'>
): void {
  if (fields.kind !== 'organisation') return;
  const issues = [
    ...(fields.role ? ['role'] : []),
    ...(fields.phone ? ['phone'] : []),
    ...(fields.pagePolicy === 'always' ? ['pagePolicy'] : []),
  ].map((path) => ({ path, message: 'content.person.organisation-field' }));
  if (issues.length)
    throw new UseCaseError(
      'invalid_input',
      'an organisation has no role, phone or profile page',
      issues
    );
}
