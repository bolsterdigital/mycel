// Route param matchers (SvelteKit 3: one `params` export). `locale` is the optional locale
// segment of a public content path (brief #8c § 8): only the *shape* of a Locale, so `/en/about`
// and `/de-AT/about` reach the loader and `/about` does not take `about` for a locale. Whether
// it is a locale of this site, and not its default (which never has a prefix, ADR 007 rule 3),
// is the loader's decision: it knows the tenant, a matcher does not.
//
// The pattern is core's `Locale` (packages/core/src/i18n/locale.ts), repeated rather than
// imported because matchers are bundled for the browser too and must not pull in the core;
// params.test.ts keeps the two equal. Page slugs that have this shape are reserved, so no page
// can hide behind a prefix.
import { defineParams } from '@sveltejs/kit/params';

const LOCALE_SHAPE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export const params = defineParams({
  locale: (param: string) => (LOCALE_SHAPE.test(param) ? param : undefined),
});
