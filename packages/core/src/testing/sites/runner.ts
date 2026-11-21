// A demo site as data, and the one runner that puts such a definition into a tenant (MY-264).
// The runner goes through the use cases only, as an editor would, so validation, revisions,
// publication, references and the search index apply to demo content exactly as to real
// content. It is additive and idempotent: what a definition names and the tenant already has
// (found by slug, filename or name) is kept untouched, what is missing is made. That lets a test
// server be brought up to date after a new feature without a reseed. Items are
// made in two rounds, as the WordPress importer does: every missing item first as an empty
// draft, so any document can link to any item, then filled, revised and published.
// Rejected: SQL or a repository write (skips the checks a use case makes), a WXR file through the
// importer (knows nothing of campaigns, forms or navigation), and one script per feature (not
// repeatable, not reviewed, never complete).

import type { z } from 'zod';
import type { ContentItem } from '../../content/model.js';
import type { NavigationDocument } from '../../navigation/model.js';
import type { Invoker } from '../../invoke.js';
import type { Principal } from '../../principal.js';
import type { FormKind } from '../../forms/model.js';
import type { BlockInput } from '../../content/blocks.js';
import { useCases } from '../../use-cases.js';
import { bytesToBase64 } from '../../util/bytes.js';
import type { L } from './rich.js';

type DocumentInput = z.input<typeof useCases.createItem.input>['document'];
type PersonInput = Omit<z.input<typeof useCases.createPerson.input>, 'slug' | 'imageId'>;
type UploadInput = z.input<typeof useCases.uploadMedia.input>;
type CampaignInput = z.input<typeof useCases.createCampaign.input>;

/** The ids of what the run found or made, by the definition's keys. */
export interface SiteRefs {
  media(key: string): string;
  person(key: string): string;
  group(key: string): string;
  section(key: string): string;
  form(key: string): string;
  item(key: string): string;
  campaign(key: string): string;
  pattern(key: string): string;
}

export interface MediaDef {
  key: string;
  /** Also how a later run recognises the asset: one filename, one asset. */
  filename: string;
  contentType: string;
  editorial?: Pick<UploadInput, 'caption' | 'credit' | 'source' | 'licence' | 'focal'>;
}

export interface PersonDef {
  key: string;
  slug: string;
  person: PersonInput;
  /** A media key: the person's portrait. */
  image?: string;
}

export interface GroupDef {
  key: string;
  /** Also how a later run recognises the group, in the site's default locale. */
  name: L;
  people: string[];
}

export interface SectionDef {
  key: string;
  slug: string;
  title: L;
  description?: L;
}

export interface FormDef {
  key: string;
  kind: FormKind;
  /** Also how a later run recognises the form, in the site's default locale. */
  name: L;
}

export interface ItemDef {
  key: string;
  slug: string;
  document(refs: SiteRefs): DocumentInput;
  /**
   * Earlier versions, saved before `document`: the item then has a revision history. Locales in
   * `behind` are published on the last of these, so their translation lags the latest revision.
   */
  earlier?: (refs: SiteRefs) => DocumentInput[];
  behind?: string[];
  /** `published` (default), `draft`, or `scheduled` for `at`. */
  status?: 'published' | 'draft' | 'scheduled';
  /** The first publication, in the past: an archive spread over time (ADR 012 rule 4). */
  publishedAt?: string;
  /** For `scheduled`: when, in the future. */
  at?: string;
}

export interface PatternDef {
  key: string;
  /** Also how a later run recognises the pattern, in the site's default locale. */
  name: L;
  intendedType: 'page' | 'article';
  blocks(refs: SiteRefs): BlockInput[];
}

export interface CampaignDef {
  key: string;
  kind: CampaignInput['kind'];
  /** An item key: the public page that carries the campaign. */
  landing: string;
  form?: string;
  goal?: CampaignInput['goal'];
  open?: boolean;
}

export interface SiteDefinition {
  slug: string;
  name: string;
  defaultLocale: string;
  locales: string[];
  media: MediaDef[];
  people: PersonDef[];
  groups: GroupDef[];
  sections: SectionDef[];
  forms: FormDef[];
  items: ItemDef[];
  patterns: PatternDef[];
  campaigns: CampaignDef[];
  /** Saved and published in every locale while the site has no published navigation. */
  navigation?(refs: SiteRefs): NavigationDocument;
}

export interface SeededItem {
  key: string;
  item: ContentItem;
  /** Made by this run; false when the tenant already had it. */
  created: boolean;
}

export interface SiteSeed {
  refs: SiteRefs;
  items: SeededItem[];
  /** Every key this run made, by kind, for the run's summary. */
  created: Record<string, string[]>;
}

/** The bytes of a definition's file. */
export type LoadMedia = (media: MediaDef) => Promise<Uint8Array>;

function lookup(kind: string, ids: Map<string, string>) {
  return (key: string) => {
    const id = ids.get(key);
    if (!id) throw new Error(`site definition: no ${kind} "${key}"`);
    return id;
  };
}

/** Every page of a cursor list. */
async function all<T>(page: (after?: string) => Promise<{ rows: T[]; next: string | null }>) {
  const rows: T[] = [];
  let after: string | undefined;
  do {
    const result = await page(after);
    rows.push(...result.rows);
    after = result.next ?? undefined;
  } while (after);
  return rows;
}

/** One run of a definition: who runs it, what it found or made, and when "now" is. */
interface Run {
  invoker: Invoker;
  principal: Principal;
  site: SiteDefinition;
  refs: SiteRefs;
  ids: Record<keyof SiteRefs, Map<string, string>>;
  created: Record<string, string[]>;
  now: Date;
}

/** The name in the site's default locale: how a group, form or pattern is recognised. */
const nameIn = (run: Run, name: L) => name[run.site.defaultLocale] ?? Object.values(name)[0];

/** For every definition: the id of what the tenant has, else of what `make` creates. */
async function ensure<D extends { key: string }>(
  run: Run,
  kind: keyof SiteRefs,
  defs: readonly D[],
  found: (def: D) => string | undefined,
  make: (def: D) => Promise<string>
) {
  for (const def of defs) {
    let id = found(def);
    if (!id) {
      id = await named(`${kind} ${def.key}`, () => make(def));
      (run.created[kind] ??= []).push(def.key);
    }
    run.ids[kind].set(def.key, id);
  }
}

export async function seedSite(
  invoker: Invoker,
  principal: Principal,
  site: SiteDefinition,
  load: LoadMedia,
  /**
   * The present, as the tenant's clock has it. A definition has fixed dates: a first publication
   * after `now` is published without its date, a schedule before `now` is published at once.
   */
  now: Date = new Date()
): Promise<SiteSeed> {
  const kinds = [
    'media',
    'person',
    'group',
    'section',
    'form',
    'item',
    'campaign',
    'pattern',
  ] as const;
  const ids = Object.fromEntries(kinds.map((k) => [k, new Map<string, string>()])) as Run['ids'];
  const refs = Object.fromEntries(kinds.map((k) => [k, lookup(k, ids[k])])) as unknown as SiteRefs;
  const run: Run = { invoker, principal, site, refs, ids, created: {}, now };

  await seedMedia(run, load);
  await seedRegister(run);
  const { fresh, kept } = await draftItems(run);
  await seedPatterns(run);
  const opening = await seedCampaigns(run);
  const seeded: SeededItem[] = [];
  for (const entry of fresh)
    seeded.push(await named(`item ${entry.def.key}`, () => fill(run, entry)));
  for (const campaignId of opening) {
    const campaign = await invoker.run(useCases.getCampaign, principal, { campaignId });
    await invoker.run(useCases.openCampaign, principal, {
      campaignId,
      baseUpdatedAt: campaign.updatedAt,
    });
  }
  await seedNavigation(run);

  const byKey = new Map([...kept, ...seeded].map((s) => [s.key, s]));
  return { refs, items: site.items.map((d) => byKey.get(d.key)!), created: run.created };
}

async function seedMedia(run: Run, load: LoadMedia) {
  const { invoker, principal } = run;
  const existing = new Map<string, string>();
  for (const media of run.site.media) {
    const kind = media.contentType.startsWith('image/')
      ? 'image'
      : media.contentType.startsWith('audio/')
        ? 'audio'
        : 'document';
    const { items } = await invoker.run(useCases.listMedia, principal, { kind, q: media.filename });
    const id = items.find((m) => m.filename === media.filename)?.id;
    if (id) existing.set(media.filename, id);
  }
  await ensure(
    run,
    'media',
    run.site.media,
    (m) => existing.get(m.filename),
    async (m) =>
      (
        await invoker.run(useCases.uploadMedia, principal, {
          filename: m.filename,
          contentType: m.contentType,
          bytes: bytesToBase64(await load(m)),
          ...m.editorial,
        })
      ).id
  );
}

async function seedRegister(run: Run) {
  const { invoker, principal, site, refs } = run;
  const people = await all(async (after) => {
    const page = await invoker.run(useCases.listPeople, principal, { after, limit: 100 });
    return { rows: page.people, next: page.next };
  });
  await ensure(
    run,
    'person',
    site.people,
    (d) => people.find((p) => p.slug === d.slug)?.id,
    async (d) =>
      (
        await invoker.run(useCases.createPerson, principal, {
          ...d.person,
          slug: d.slug,
          ...(d.image && { imageId: refs.media(d.image) }),
        })
      ).id
  );
  const { groups } = await invoker.run(useCases.listPersonGroups, principal, { limit: 100 });
  await ensure(
    run,
    'group',
    site.groups,
    (d) => groups.find((g) => nameIn(run, g.name) === nameIn(run, d.name))?.id,
    async (d) =>
      (
        await invoker.run(useCases.createPersonGroup, principal, {
          name: d.name,
          personIds: d.people.map(refs.person),
        })
      ).id
  );
  const sections = await all(async (after) => {
    const page = await invoker.run(useCases.listSections, principal, { after, limit: 100 });
    return { rows: page.sections, next: page.next };
  });
  await ensure(
    run,
    'section',
    site.sections,
    (d) => sections.find((s) => s.slug === d.slug)?.id,
    async ({ key: _key, ...input }) =>
      (await invoker.run(useCases.createSection, principal, input)).id
  );
  const { forms } = await invoker.run(useCases.listForms, principal, {});
  await ensure(
    run,
    'form',
    site.forms,
    (d) =>
      forms.find((f) => f.kind === d.kind && f.name && nameIn(run, f.name) === nameIn(run, d.name))
        ?.id,
    async (d) => {
      const form = await invoker.run(useCases.createForm, principal, { kind: d.kind });
      const { version } = await invoker.run(useCases.getFormForAuthoring, principal, {
        id: form.id,
      });
      await invoker.run(useCases.updateForm, principal, {
        baseVersion: version,
        value: { ...form, name: d.name },
      });
      return form.id;
    }
  );
}

interface Fresh {
  def: ItemDef;
  item: ContentItem;
  revisionId: string;
}

/** Round one: every missing item as an empty draft of the right type and profile. */
async function draftItems(run: Run) {
  const { invoker, principal } = run;
  const fresh: Fresh[] = [];
  const kept: SeededItem[] = [];
  const found = new Map<string, ContentItem>();
  for (const def of run.site.items) {
    const { type } = def.document(placeholderRefs);
    const { items } = await invoker.run(useCases.listItems, principal, { type, slug: def.slug });
    if (items[0]) {
      found.set(def.key, items[0]);
      kept.push({ key: def.key, item: items[0], created: false });
    }
  }
  await ensure(
    run,
    'item',
    run.site.items,
    (def) => found.get(def.key)?.id,
    async (def) => {
      const skeleton = def.document(placeholderRefs);
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug: def.slug,
        document: {
          type: skeleton.type,
          title: skeleton.title,
          defaultLocale: skeleton.defaultLocale,
          locales: skeleton.locales,
          blocks: [],
          ...(skeleton.type === 'page' && skeleton.profile && { profile: skeleton.profile }),
        } as DocumentInput,
      });
      fresh.push({ def, item, revisionId: revision.id });
      return item.id;
    }
  );
  return { fresh, kept };
}

async function seedPatterns(run: Run) {
  const { invoker, principal, refs } = run;
  const patterns = await all(async (after) => {
    const page = await invoker.run(useCases.listPatterns, principal, { after, limit: 100 });
    return { rows: page.patterns, next: page.next };
  });
  await ensure(
    run,
    'pattern',
    run.site.patterns,
    (d) => patterns.find((p) => nameIn(run, p.name) === nameIn(run, d.name))?.id,
    async (d) =>
      (
        await invoker.run(useCases.createPattern, principal, {
          name: d.name,
          intendedType: d.intendedType,
          blocks: d.blocks(refs),
        })
      ).id
  );
}

/**
 * A campaign before the documents: a card in any item names it. Its landing page is still a
 * draft here; the campaigns this run made open once that page is published.
 */
async function seedCampaigns(run: Run): Promise<string[]> {
  const { invoker, principal, refs } = run;
  const { campaigns } = await invoker.run(useCases.listCampaigns, principal, { limit: 100 });
  const opening: string[] = [];
  await ensure(
    run,
    'campaign',
    run.site.campaigns,
    (d) => campaigns.find((c) => c.landingItemId === refs.item(d.landing))?.id,
    async (d) => {
      const { id } = await invoker.run(useCases.createCampaign, principal, {
        kind: d.kind,
        landingItemId: refs.item(d.landing),
        formId: d.form ? refs.form(d.form) : null,
        goal: d.goal ?? null,
      });
      if (d.open !== false) opening.push(id);
      return id;
    }
  );
  return opening;
}

/** Round two: fill, revise and publish or schedule an item this run made. */
async function fill(run: Run, { def, item, revisionId }: Fresh): Promise<SeededItem> {
  const { invoker, principal, refs, now } = run;
  let base = revisionId;
  const save = async (document: DocumentInput) => {
    const saved = await invoker.run(useCases.updateItem, principal, {
      itemId: item.id,
      baseRevisionId: base,
      document,
    });
    base = saved.revision.id;
  };
  const first = def.publishedAt && Date.parse(def.publishedAt) <= now.getTime();
  const publish = (locale: string) =>
    invoker.run(useCases.publishItem, principal, {
      itemId: item.id,
      revisionId: base,
      locale,
      ...(first && { firstPublishedAt: def.publishedAt }),
    });
  const document = def.document(refs);
  const status =
    def.status === 'scheduled' && Date.parse(def.at!) <= now.getTime()
      ? 'published'
      : (def.status ?? 'published');
  for (const earlier of def.earlier?.(refs) ?? []) await save(earlier);
  if (status === 'published') for (const locale of def.behind ?? []) await publish(locale);
  await save(document);
  const locales = document.locales.filter((l) => !def.behind?.includes(l));
  if (status === 'published') for (const locale of locales) await publish(locale);
  if (status === 'scheduled')
    for (const locale of locales)
      await invoker.run(useCases.scheduleItem, principal, {
        itemId: item.id,
        revisionId: base,
        locale,
        at: def.at!,
      });
  const latest = await invoker.run(useCases.getItem, principal, { itemId: item.id });
  return { key: def.key, item: latest.item, created: true };
}

/** Saved and published in every locale while the site has no published navigation. */
async function seedNavigation(run: Run) {
  const { invoker, principal, site } = run;
  if (!site.navigation) return;
  const state = await invoker.run(useCases.getNavigation, principal, {});
  if (state.publication.length > 0) return;
  const saved = await invoker.run(useCases.updateNavigation, principal, {
    baseRevisionId: state.revisionId,
    document: site.navigation(run.refs),
  });
  for (const locale of site.locales)
    await invoker.run(useCases.publishNavigation, principal, {
      revisionId: saved.revisionId!,
      locale,
    });
  (run.created['navigation'] ??= []).push('navigation');
}

/** `work()`, with a refusal naming what the definition was making and the first issues. */
async function named<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const e = error as { message?: string; issues?: { path: string; message: string }[] };
    const issues = (e.issues ?? []).slice(0, 5).map((i) => `${i.path}: ${i.message}`);
    throw new Error(
      `site definition, ${what}: ${e.message ?? String(error)}${issues.length ? ` (${issues.join('; ')})` : ''}`,
      { cause: error }
    );
  }
}

/** Refs for reading a document's type, title and locales before anything exists. */
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const placeholderRefs: SiteRefs = {
  media: () => PLACEHOLDER,
  person: () => PLACEHOLDER,
  group: () => PLACEHOLDER,
  section: () => PLACEHOLDER,
  form: () => PLACEHOLDER,
  item: () => PLACEHOLDER,
  campaign: () => PLACEHOLDER,
  pattern: () => PLACEHOLDER,
};
