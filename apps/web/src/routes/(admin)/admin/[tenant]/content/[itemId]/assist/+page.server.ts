// A native suggestion page keeps the source and revision visible across 303 refreshes. Rejected:
// accepting a suggestion id alone, which would let a forged POST select another field or item.
import {
  can,
  decodeTranslation,
  leadCandidates,
  sectionCandidates,
  translationValue,
  useCases,
  UseCaseError,
} from '@mycel/core';
import { error, fail, redirect } from '@sveltejs/kit';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { contentLocale } from '#lib/server/content/content-locale.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';
import { langOf, ui } from '../../../../../../../i18n/index.js';
import { refuse, refusalOf } from '#lib/server/http/refuse.js';

const read = async <T>(locals: App.Locals, query: () => Promise<T>): Promise<T> => {
  try {
    return await query();
  } catch (e) {
    const refusal = refusalOf(e);
    const { status, problem } = failure(refusal);
    error(
      status,
      ui(langOf(locals))(
        refusal.code === 'not_found'
          ? 'admin.assist.error.not_found'
          : `admin.assist.error.${problem}`
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
  const t = ui(langOf(event.locals));
  if (!can(principal, 'ai:assist') || !can(principal, 'content:write')) refuse(403);
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
      refuse(404);
  } else if (task === 'lead' || task === 'headline' || task === 'section') {
    if (item.type !== 'article' || !revision.document.locales.includes(locale)) refuse(404);
  } else if (task === 'translate') {
    if (
      from === to ||
      !revision.document.locales.includes(from) ||
      !revision.document.locales.includes(to) ||
      translationValue(revision.document, target, from) === null
    )
      refuse(404);
  } else refuse(404);
  return {
    tenant,
    principal,
    item,
    revision,
    task,
    locale,
    block,
    from,
    to,
    target,
    rt,
    provider: settings.provider,
  };
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
    task: string;
    blockId: string;
    locale: string;
  }
) => {
  if (suggestion.itemId !== c.item.id || suggestion.task !== c.task) return false;
  if (c.task === 'lead' || c.task === 'headline' || c.task === 'section')
    return suggestion.locale === c.locale;
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

/** A refusal whose own reason the page words, else its code. */
const SPECIFIC = [
  'article',
  'lead-source',
  'lead-too-long',
  'lead-value',
  'headline-source',
  'headline-value',
  'section-source',
  'section-candidates',
  'section-value',
] as const;
const failure = (e: UseCaseError) => {
  const issue = e.issues?.[0]?.message.replace(/^assist\.error\./, '');
  const specific = SPECIFIC.find((s) => s === issue);
  return specific ? { status: 400, problem: specific } : coded(e);
};
const coded = (e: UseCaseError) => ({
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

/** The sections a section request offers, from every page of the list, as core offers them. */
const offeredSections = async (c: Awaited<ReturnType<typeof context>>) => {
  const all = [];
  let after: string | undefined;
  do {
    const page = await c.rt.invoker.run(useCases.listSections, c.principal, { after, limit: 100 });
    all.push(...page.sections);
    after = page.next ?? undefined;
  } while (after);
  const offered = sectionCandidates(all, c.locale);
  return offered.ok ? offered.candidates : [];
};

export const load: PageServerLoad = async (event) => {
  const parent = await event.parent();
  const c = await context(event);
  const candidates = c.task === 'lead' ? leadCandidates(c.revision.document, c.locale) : [];
  const sections = c.task === 'section' ? await offeredSections(c) : [];
  const source =
    c.task === 'lead'
      ? ''
      : c.task === 'headline' || c.task === 'section'
        ? (c.revision.document.lead?.[c.locale] ?? '')
        : c.task === 'alt'
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
  if (suggestion && !matches(c, suggestion)) refuse(404);
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
    // A proposed section that is no longer offered (removed, or untitled in this locale) is stale.
    stale:
      !!suggestion &&
      (suggestion.baseRevisionId !== c.revision.id ||
        (c.task === 'section' &&
          suggestion.status === 'ready' &&
          !sections.some((s) => s.id === suggestion.value))),
    candidates,
    sections,
    chosen: suggestion?.sourceBlockIds ?? [],
    provider: c.provider ?? '',
    tenant: { slug: c.tenant.slug },
    query: `&${event.url.searchParams.toString()}`,
  };
};

export const actions: Actions = {
  request: async (event) => {
    const c = await context(event);
    const data = await event.request.formData();
    const blockIds = data.getAll('blockId').map(String);
    // No box or more than three ticked is the editor's choice to correct, worded as such.
    if (c.task === 'lead' && (blockIds.length < 1 || blockIds.length > 3))
      return fail(400, { problem: 'lead-source' as const, blockIds });
    try {
      const result =
        c.task === 'headline' || c.task === 'section'
          ? await c.rt.invoker.run(
              c.task === 'section' ? useCases.suggestSection : useCases.suggestHeadline,
              c.principal,
              { itemId: c.item.id, baseRevisionId: field(data, 'baseRevisionId'), locale: c.locale }
            )
          : c.task === 'lead'
            ? await c.rt.invoker.run(useCases.suggestLead, c.principal, {
                itemId: c.item.id,
                baseRevisionId: field(data, 'baseRevisionId'),
                locale: c.locale,
                blockIds,
              })
            : c.task === 'alt'
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
      const { status, problem } = failure(refusalOf(e));
      return fail(status, { problem, blockIds });
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
    if (!matches(c, suggestion)) refuse(404);
    // A section is taken as proposed; the form has no value to edit (ADR 021).
    const value =
      c.task === 'translate'
        ? JSON.stringify({ values: { [c.target]: field(data, 'value') } })
        : c.task === 'section'
          ? undefined
          : field(data, 'value');
    try {
      await c.rt.invoker.run(useCases.acceptSuggestion, c.principal, {
        suggestionId,
        baseRevisionId: field(data, 'baseRevisionId'),
        value,
      });
      // Back on the edit screen in the locale the suggestion was for (#66 PR 4), named only when
      // it is not the operator's content locale anyway.
      const locale = c.task === 'translate' ? c.to : c.locale;
      const shown = locale !== contentLocale(event.cookies, c.tenant) ? `&locale=${locale}` : '';
      redirect(303, `/admin/${c.tenant.slug}/content/${c.item.id}?saved=1${shown}`);
    } catch (e) {
      const { status, problem } = failure(refusalOf(e));
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
    if (!matches(c, suggestion)) refuse(404);
    try {
      await c.rt.invoker.run(useCases.dismissSuggestion, c.principal, { suggestionId });
      redirect(303, urlOf(event.url));
    } catch (e) {
      const { status, problem } = failure(refusalOf(e));
      return fail(status, { problem });
    }
  },
};
