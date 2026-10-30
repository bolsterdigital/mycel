// A native suggestion page keeps the source and revision visible across 303 refreshes. Rejected:
// accepting a suggestion id alone, which would let a forged POST select another field or item.
import { can, decodeTranslation, translationValue, useCases, UseCaseError } from '@mycel/core';
import { error, fail, redirect } from '@sveltejs/kit';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';
import { ui } from '../../../../../../../i18n/index.js';

const read = async <T>(locals: App.Locals, query: () => Promise<T>): Promise<T> => {
  try {
    return await query();
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    const { status, problem } = failure(e);
    error(
      status,
      ui(locals.lang ?? 'en')(
        e.code === 'not_found' ? 'admin.assist.error.not_found' : `admin.assist.error.${problem}`
      )
    );
  }
};

const field = (data: FormData, name: string) => String(data.get(name) ?? '');
const context = async (event: {
  locals: App.Locals;
  url: URL;
  params: { tenant: string; itemId: string };
}) => {
  const { tenant, principal } = await requireTenantPrincipal(
    event.locals,
    event.url,
    event.params.tenant
  );
  const t = ui(event.locals.lang ?? 'en');
  if (!can(principal, 'ai:assist') || !can(principal, 'content:write'))
    error(403, t('admin.assist.error.forbidden'));
  const rt = runtime();
  const settings = await rt.invoker.run(useCases.getAssistSettings, principal, {});
  if (
    !principal.entitlements['ai.assist'] ||
    !settings.enabled ||
    !settings.provider ||
    settings.consentedProvider !== settings.provider
  )
    error(403, t('admin.assist.error.disabled'));
  const { item, revision } = await read(event.locals, () =>
    rt.invoker.run(useCases.getItem, principal, {
      itemId: event.params.itemId,
    })
  );
  if (revision.document.access.level !== 'public' && !settings.allowRestricted)
    error(403, t('admin.assist.error.restricted'));
  const task = event.url.searchParams.get('task');
  const locale = event.url.searchParams.get('locale') ?? '';
  const block = event.url.searchParams.get('block') ?? '';
  const from = event.url.searchParams.get('from') ?? '';
  const to = event.url.searchParams.get('to') ?? '';
  const target = event.url.searchParams.get('target') ?? '';
  if (task === 'alt') {
    const image = revision.document.blocks.find((b) => b.id === block);
    if (
      !image ||
      image.type !== 'image' ||
      image.props.decorative ||
      !revision.document.locales.includes(locale)
    )
      error(404, t('admin.assist.error.not_found'));
  } else if (task === 'translate') {
    if (
      from === to ||
      !revision.document.locales.includes(from) ||
      !revision.document.locales.includes(to) ||
      translationValue(revision.document, target, from) === null
    )
      error(404, t('admin.assist.error.not_found'));
  } else error(404, t('admin.assist.error.not_found'));
  return { tenant, principal, item, revision, task, locale, block, from, to, target, rt };
};

const urlOf = (url: URL, id?: string) => {
  const next = new URL(url);
  for (const action of ['/request', '/accept', '/dismiss']) next.searchParams.delete(action);
  next.searchParams.delete('suggestion');
  if (id) next.searchParams.set('suggestion', id);
  return next.pathname + next.search;
};

const matches = (
  c: Awaited<ReturnType<typeof context>>,
  suggestion: {
    itemId: string;
    blockId: string;
    locale: string;
  }
) => {
  if (suggestion.itemId !== c.item.id) return false;
  if (c.task === 'alt') return suggestion.blockId === c.block && suggestion.locale === c.locale;
  const descriptor = decodeTranslation(suggestion.blockId);
  return (
    !!descriptor &&
    descriptor.from === c.from &&
    descriptor.to === c.to &&
    suggestion.locale === c.to &&
    descriptor.targets.length === 1 &&
    descriptor.targets[0] === c.target
  );
};

const failure = (e: UseCaseError) => ({
  status:
    e.code === 'conflict'
      ? 409
      : e.code === 'forbidden' || e.code === 'suspended'
        ? 403
        : e.code === 'not_found'
          ? 404
          : 400,
  problem: e.code === 'suspended' || e.code === 'not_found' ? 'invalid_input' : e.code,
});

export const load: PageServerLoad = async (event) => {
  const parent = await event.parent();
  const c = await context(event);
  const source =
    c.task === 'alt'
      ? ((
          c.revision.document.blocks.find((b) => b.id === c.block) as {
            props: { alt?: Record<string, string> };
          }
        ).props.alt?.[c.locale] ?? '')
      : (translationValue(c.revision.document, c.target, c.from) ?? '');
  const id = event.url.searchParams.get('suggestion');
  const suggestion = id
    ? await read(event.locals, () =>
        c.rt.invoker.run(useCases.getSuggestion, c.principal, { suggestionId: id })
      )
    : null;
  if (suggestion && !matches(c, suggestion))
    error(404, ui(event.locals.lang ?? 'en')('admin.assist.error.not_found'));
  const translated =
    suggestion?.value && c.task === 'translate'
      ? (() => {
          try {
            const result = JSON.parse(suggestion.value!);
            return String(result.values?.[c.target] ?? '');
          } catch {
            return '';
          }
        })()
      : null;
  return {
    adminLocale: parent.locale,
    contentType: c.item.type,
    task: c.task,
    source,
    suggestion,
    value: translated ?? suggestion?.value ?? '',
    revisionId: c.revision.id,
    itemId: c.item.id,
    locale: c.locale,
    from: c.from,
    to: c.to,
    target: c.target,
    block: c.block,
    stale: !!suggestion && suggestion.baseRevisionId !== c.revision.id,
    tenant: { slug: c.tenant.slug },
    query: `&${event.url.searchParams.toString()}`,
  };
};

export const actions: Actions = {
  request: async (event) => {
    const c = await context(event);
    const data = await event.request.formData();
    try {
      const result =
        c.task === 'alt'
          ? await c.rt.invoker.run(useCases.suggestAlt, c.principal, {
              itemId: c.item.id,
              baseRevisionId: field(data, 'baseRevisionId'),
              blockId: c.block,
              locale: c.locale,
            })
          : await c.rt.invoker.run(useCases.suggestTranslation, c.principal, {
              itemId: c.item.id,
              baseRevisionId: field(data, 'baseRevisionId'),
              from: c.from,
              to: c.to,
              targets: [c.target],
            });
      redirect(303, urlOf(event.url, result.suggestionId));
    } catch (e) {
      if (!(e instanceof UseCaseError)) throw e;
      const { status, problem } = failure(e);
      return fail(status, { problem });
    }
  },
  accept: async (event) => {
    const c = await context(event);
    const data = await event.request.formData();
    const suggestionId = field(data, 'suggestionId');
    const suggestion = await read(event.locals, () =>
      c.rt.invoker.run(useCases.getSuggestion, c.principal, {
        suggestionId,
      })
    );
    if (!matches(c, suggestion))
      error(404, ui(event.locals.lang ?? 'en')('admin.assist.error.not_found'));
    const value =
      c.task === 'translate'
        ? JSON.stringify({ values: { [c.target]: field(data, 'value') } })
        : field(data, 'value');
    try {
      await c.rt.invoker.run(useCases.acceptSuggestion, c.principal, {
        suggestionId,
        baseRevisionId: field(data, 'baseRevisionId'),
        value,
      });
      redirect(303, `/admin/${c.tenant.slug}/content/${c.item.id}?saved=1`);
    } catch (e) {
      if (!(e instanceof UseCaseError)) throw e;
      const { status, problem } = failure(e);
      return fail(status, { problem, value: field(data, 'value') });
    }
  },
  dismiss: async (event) => {
    const c = await context(event);
    const data = await event.request.formData();
    const suggestionId = field(data, 'suggestionId');
    const suggestion = await read(event.locals, () =>
      c.rt.invoker.run(useCases.getSuggestion, c.principal, {
        suggestionId,
      })
    );
    if (!matches(c, suggestion))
      error(404, ui(event.locals.lang ?? 'en')('admin.assist.error.not_found'));
    try {
      await c.rt.invoker.run(useCases.dismissSuggestion, c.principal, { suggestionId });
      redirect(303, urlOf(event.url));
    } catch (e) {
      if (!(e instanceof UseCaseError)) throw e;
      const { status, problem } = failure(e);
      return fail(status, { problem });
    }
  },
};
