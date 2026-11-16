// The site's patterns under Library (ADR 012 rule 8): every saved pattern with its type and size,
// renamed in the content locale or deleted in place. Saving one happens on the edit screen
// ("Save as pattern"), so there is no create form here. A rename keeps the blocks and their ids;
// a delete leaves the documents made or filled from the pattern untouched (their copies are
// independent, ADR 013 rule 4 as refined 2026-11-16).
// Rejected: a page per pattern with a block editor, which would be a second editor for content
// that an editor changes by inserting, editing and saving again.
import { MAX_PAGE_SIZE, UseCaseError, can, pickAny, useCases, type BlockInput } from '@mycel/core';
import { act, loaded, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { contentLocale, tenant } = await parent();
  const principal = locals.principal!;
  const { patterns } = await loaded(
    runtime().invoker.run(useCases.listPatterns, principal, { limit: MAX_PAGE_SIZE })
  );
  return {
    patterns: patterns.map((p) => ({
      id: p.id,
      name: pickAny(p.name, contentLocale, tenant.defaultLocale) ?? '',
      type: p.intendedType,
      blocks: p.blocks.length,
    })),
    write: can(principal, 'content:write'),
  };
};

const copy = {
  conflict: 'admin.error.invalid',
  notFound: 'admin.pattern.manage.notFound',
  issues: { 'pattern.name-required': 'admin.pattern.save.nameRequired' },
} as const;

export const actions: Actions = {
  rename: (event) =>
    act(event, 'rename', copy, async (principal, data) => {
      const patternId = text(data, 'patternId');
      const name = text(data, `name-${patternId}`).trim();
      if (!name)
        throw new UseCaseError('invalid_input', 'a pattern needs a name', [
          { path: 'name', message: 'pattern.name-required' },
        ]);
      const { invoker } = runtime();
      const {
        id: _id,
        createdAt: _c,
        updatedAt: _u,
        blocks,
        ...pattern
      } = await invoker.run(useCases.getPattern, principal, { patternId });
      await invoker.run(useCases.updatePattern, principal, {
        ...pattern,
        patternId,
        name: { ...pattern.name, [text(data, 'locale')]: name },
        blocks: blocks.map(({ id: _b, ...b }) => b as BlockInput),
      });
      return { action: 'rename', done: 'admin.pattern.manage.renamed' as const, name };
    }),
  delete: (event) =>
    act(event, 'delete', copy, async (principal, data) => {
      const patternId = text(data, 'patternId');
      await runtime().invoker.run(useCases.deletePattern, principal, { patternId });
      return { action: 'delete', done: 'admin.pattern.manage.deleted' as const, name: '' };
    }),
};
