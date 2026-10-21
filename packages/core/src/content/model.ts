// Pages are JSON documents: metadata plus blocks, each block a typed, versioned schema (ADR 004).
// Unknown block types fail validation instead of being stored. Rendering is not here: the core
// knows nothing about HTML. The probe needs two block types; the registry grows by entry.

import { z } from 'zod';
import { Locale, coversLocales, localized } from '../i18n/locale.js';

export const HeadingBlock = z.object({
  type: z.literal('heading'),
  version: z.literal(1),
  // No `level` prop: the renderer derives the heading level from tree depth (ADR 004 rule 3).
  props: z.object({ text: localized(z.string().min(1).max(200)) }),
});

export const SignupFormBlock = z.object({
  type: z.literal('signup-form'),
  version: z.literal(1),
  // A reference, never a copy: the forms module owns the fields (ADR 004 rule 6).
  props: z.object({ formId: z.string().uuid() }),
});

export const Block = z.discriminatedUnion('type', [HeadingBlock, SignupFormBlock]);
export type Block = z.infer<typeof Block>;

export const PageSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'content.slug.invalid');

export const PageInput = z
  .object({
    slug: PageSlug,
    defaultLocale: Locale,
    locales: z.array(Locale).min(1),
    title: localized(z.string().min(1).max(200)),
    blocks: z.array(Block).max(200),
  })
  .superRefine((page, ctx) => {
    if (!page.locales.includes(page.defaultLocale))
      ctx.addIssue({
        code: 'custom',
        path: ['defaultLocale'],
        message: 'i18n.default-not-in-locales',
      });
    // Every localisable field must at least exist in the default locale, so rendering can always
    // fall back. Missing translations in other locales are allowed (and reportable later).
    const required = [page.defaultLocale];
    if (!coversLocales(page.title, required))
      ctx.addIssue({ code: 'custom', path: ['title'], message: 'i18n.missing-default-locale' });
    page.blocks.forEach((block, i) => {
      if (block.type === 'heading' && !coversLocales(block.props.text, required))
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', i, 'props', 'text'],
          message: 'i18n.missing-default-locale',
        });
    });
  });
export type PageInput = z.infer<typeof PageInput>;

export const Page = z.object({
  id: z.string().uuid(),
  slug: PageSlug,
  defaultLocale: Locale,
  locales: z.array(Locale).min(1),
  title: localized(z.string()),
  blocks: z.array(Block),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Page = z.infer<typeof Page>;

/** The form ids a page references, for integrity checks and for renderers that resolve them. */
export function referencedFormIds(blocks: readonly Block[]): string[] {
  return [...new Set(blocks.flatMap((b) => (b.type === 'signup-form' ? [b.props.formId] : [])))];
}
