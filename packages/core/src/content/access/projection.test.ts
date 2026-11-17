// The access projection in memory (ADR 016 rule 3, ADR 018 rules 6 and 7): what
// `content.published.get` hands a visitor, a reader without the tier and a reader with it. Each
// hidden place carries a sentinel, and the test reads the serialised answer for it, so a field
// that starts carrying the body fails here whatever its name is. The same sentinels through the
// site's HTML and Markdown are apps/web/e2e; RLS and two tenants in Postgres are packages/db.
// Restricted media come to a reader with access only, as paths signed for one item and locale.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import {
  anonymousPrincipal,
  readerPrincipal,
  systemPrincipal,
  type Principal,
} from '../../principal.js';
import { SupporterEvent } from '../../supporters/events.js';
import { ingest } from '../../supporters/service.js';
import { FakeClock, MemoryUnitOfWork, TENANT, principal } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
import { publicItemPath } from '../../mailing/email.js';
import type { ContentDocument } from '../model.js';
import { EXAMPLE_PNG } from '../../media/service.js';
import { readerMediaScope, verifyMediaSignature } from '../../media/signed-paths.js';
import { READER_MEDIA_TTL_MS, teaserBlocks, teaserDocument } from './projection.js';

const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const HOUR = 60 * 60 * 1000;

const text = (t: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: t }] }],
});
const rich = (id: string, nl: string, en = `EN-${nl}`) => ({
  id,
  type: 'rich-text' as const,
  version: 1 as const,
  props: { content: { nl: text(nl), en: text(en) } },
});
const head = (id: string, nl: string, en = `EN-${nl}`) => ({
  id,
  type: 'heading' as const,
  version: 1 as const,
  props: { text: { nl, en } },
});
const paywall = { id: 'wall', type: 'paywall' as const, version: 1 as const, props: {} };

/** Everything a visitor without access must never receive, in any field of the answer. */
const HIDDEN = [
  'SENTINEL-BODY',
  'SENTINEL-TAIL',
  'SENTINEL-CORRECTION',
  'SENTINEL-EN',
  'sentinel-author@example.org',
  'SENTINEL-PLACE',
  'sentinel-meeting.example.org',
];
const hidden = (answer: unknown) => HIDDEN.filter((s) => JSON.stringify(answer).includes(s));

describe('the access projection of a published item', () => {
  let clock: FakeClock;
  let uow: MemoryUnitOfWork;
  let invoker: Invoker;
  const admin = (tenant = TENANT) => systemPrincipal(tenant, 'test');
  const visitor = (tenant = TENANT) => anonymousPrincipal(tenant, ['content:read']);

  beforeEach(() => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
  });

  /** A supporter with an open reader session, as the web front holds it after a sign-in. */
  async function reader(email: string, tenant = TENANT) {
    await uow.run(admin(tenant), (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `seen-${tenant}-${email}`,
          type: 'newsletter.subscribed',
          email,
          occurred_at: clock.now().toISOString(),
          source: 'test',
          source_site: 'urn:mycel:test',
          source_ref: email,
          props: { list: 'news' },
        })
      )
    );
    const supporter = await invoker.run(useCases.getSupporter, admin(tenant), { email });
    const sessionId = uow.ids.next();
    await uow.run(admin(tenant), (ctx) =>
      ctx.readerSessions.insert({
        id: sessionId,
        supporterId: supporter.id,
        createdAt: clock.now(),
        expiresAt: new Date(clock.now().getTime() + 12 * HOUR),
        revokedAt: null,
      })
    );
    return { supporterId: supporter.id, sessionId, as: readerPrincipal(tenant, sessionId) };
  }

  const tier = (slug: string, tenant = TENANT) =>
    invoker.run(useCases.createAccessTier, admin(tenant), { slug, name: { nl: slug, en: slug } });

  async function article(
    slug: string,
    access: ContentDocument['access'] | { level: 'members' | 'tier'; [k: string]: unknown },
    over: Record<string, unknown> = {},
    tenant = TENANT
  ) {
    const author = await invoker.run(useCases.createPerson, admin(tenant), {
      slug: `sam-${slug}`,
      name: 'Sam',
      email: 'sentinel-author@example.org',
    });
    const { item, revision } = await invoker.run(useCases.createItem, admin(tenant), {
      slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Titel', en: 'SENTINEL-EN title' },
        lead: { nl: 'De lead.', en: 'SENTINEL-EN lead' },
        authorIds: [author.id],
        corrections: [
          { date: '2026-11-01', text: { nl: 'SENTINEL-CORRECTION', en: 'SENTINEL-EN c' } },
        ],
        blocks: [
          rich('open', 'Open alinea.', 'SENTINEL-EN open'),
          paywall,
          rich('body', 'SENTINEL-BODY', 'SENTINEL-EN body'),
          head('tail', 'SENTINEL-TAIL', 'SENTINEL-EN tail'),
        ],
        access,
        ...over,
      } as never,
    });
    // Only `nl` is published: `en` stays a draft translation in the same revision.
    await invoker.run(useCases.publishItem, admin(tenant), {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    return item;
  }
  const read = (slug: string, as: Principal, type: 'article' | 'page' = 'article') =>
    invoker.run(useCases.getPublished, as, { type, slug });
  const ids = (answer: { blocks: { id: string }[] }) => answer.blocks.map((b) => b.id);

  it('gives a visitor the title, the lead and the marker teaser, and nothing behind it', async () => {
    const t = await tier('donateurs');
    await article('stuk', { level: 'tier', tierIds: [t.id], teaser: 'marker' });
    const answer = await read('stuk', visitor());
    expect(answer.gate).toEqual({ prompt: 'signin' });
    expect(answer.access).toBe('tier');
    expect([answer.title, answer.lead, ids(answer)]).toEqual(['Titel', 'De lead.', ['open']]);
    expect(answer.corrections).toEqual([]);
    expect(answer.authors).toEqual([expect.objectContaining({ name: 'Sam' })]);
    expect(hidden(answer)).toEqual([]);
  });

  it.each([
    ['lead', [], 'De lead.'],
    ['marker', ['open'], 'De lead.'],
    [{ blocks: 1 }, ['open'], 'De lead.'],
  ] as const)('cuts teaser %o before anything is derived', async (teaser, shown, summary) => {
    const blocks =
      teaser === 'marker'
        ? undefined
        : [
            rich('open', 'Open alinea.'),
            head('tail', 'SENTINEL-TAIL'),
            rich('body', 'SENTINEL-BODY'),
          ];
    await article('stuk', { level: 'members', teaser }, blocks ? { blocks } : {});
    const answer = await read('stuk', visitor());
    expect(ids(answer)).toEqual(shown);
    expect(answer.effective.summary.text).toBe(summary);
    expect(hidden(answer)).toEqual([]);
  });

  it('derives a description from the teaser only, never from the first hidden paragraph', async () => {
    // No lead and a `blocks: 0` teaser: the chain's last link is the body, and that is cut.
    await article(
      'kaal',
      { level: 'members', teaser: { blocks: 0 } },
      { lead: undefined, blocks: [rich('body', 'SENTINEL-BODY')] }
    );
    const answer = await read('kaal', visitor());
    expect(answer.effective.seoDescription).toEqual({ text: null, source: null });
    expect(hidden(answer)).toEqual([]);
  });

  it('serves the whole item to a reader with a standing grant, paywall block included', async () => {
    const t = await tier('donateurs');
    await article('stuk', { level: 'tier', tierIds: [t.id], teaser: 'marker' });
    const ada = await reader('ada@example.org');
    await invoker.run(useCases.createAccessGrant, admin(), {
      supporterId: ada.supporterId,
      tierId: t.id,
      kind: 'comp',
      reason: 'test',
    });
    const answer = await read('stuk', ada.as);
    expect(answer.gate).toBeNull();
    expect(ids(answer)).toEqual(['open', 'wall', 'body', 'tail']);
    expect(answer.corrections).toEqual([{ date: '2026-11-01', text: 'SENTINEL-CORRECTION' }]);
    // The unpublished translation and the author's address stay inside for a reader too.
    expect(hidden(answer)).toEqual(['SENTINEL-BODY', 'SENTINEL-TAIL', 'SENTINEL-CORRECTION']);
  });

  it('tells a reader without the tier apart from a visitor, and shows both the same teaser', async () => {
    const [t, other] = [await tier('donateurs'), await tier('pers')];
    await article('stuk', { level: 'tier', tierIds: [t.id], teaser: 'marker' });
    const ada = await reader('ada@example.org');
    await invoker.run(useCases.createAccessGrant, admin(), {
      supporterId: ada.supporterId,
      tierId: other.id,
      kind: 'gift',
      reason: 'test',
    });
    const answer = await read('stuk', ada.as);
    expect(answer.gate).toEqual({ prompt: 'tier' });
    expect({ ...answer, gate: null }).toEqual({ ...(await read('stuk', visitor())), gate: null });
  });

  it('opens a members item to any signed-in reader', async () => {
    await article('leden', { level: 'members', teaser: 'marker' });
    const ada = await reader('ada@example.org');
    expect((await read('leden', ada.as)).gate).toBeNull();
    expect((await read('leden', visitor())).gate).toEqual({ prompt: 'signin' });
  });

  it('closes at the moment a grant ends, inside a session that is still open', async () => {
    const t = await tier('donateurs');
    await article('stuk', { level: 'tier', tierIds: [t.id], teaser: 'marker' });
    const ada = await reader('ada@example.org');
    const until = new Date(clock.now().getTime() + HOUR);
    await invoker.run(useCases.createAccessGrant, admin(), {
      supporterId: ada.supporterId,
      tierId: t.id,
      kind: 'comp',
      reason: 'test',
      until: until.toISOString(),
    });
    clock.advance(HOUR - 1);
    expect((await read('stuk', ada.as)).gate).toBeNull();
    clock.advance(1);
    const after = await read('stuk', ada.as);
    expect(after.gate).toEqual({ prompt: 'tier' });
    expect(hidden(after)).toEqual([]);
  });

  it('signs the item’s restricted media for a reader with access only, until the grant ends', async () => {
    const t = await tier('donateurs');
    const upload = (access: 'public' | 'restricted') =>
      invoker.run(useCases.uploadMedia, admin(), {
        filename: 'pixel.png',
        contentType: 'image/png',
        bytes: EXAMPLE_PNG,
        access,
      });
    const [hero, inside, open] = [
      await upload('restricted'),
      await upload('restricted'),
      await upload('public'),
    ];
    const image = (id: string, mediaId: string) => ({
      id,
      type: 'image' as const,
      version: 1 as const,
      props: { mediaId, decorative: true, alt: null },
    });
    const item = await article(
      'beeld',
      { level: 'tier', tierIds: [t.id], teaser: 'marker' },
      {
        heroImageId: hero.id,
        // The featured image is a card's: a reader gets no signed path for it.
        featuredImageId: inside.id,
        blocks: [rich('open', 'Open.'), paywall, image('foto', inside.id), image('vrij', open.id)],
      }
    );
    const [ada, bob] = [await reader('ada@example.org'), await reader('bob@example.org')];
    const ends = new Date(clock.now().getTime() + 3 * 60 * 1000);
    await invoker.run(useCases.createAccessGrant, admin(), {
      supporterId: ada.supporterId,
      tierId: t.id,
      kind: 'comp',
      reason: 'test',
      until: ends.toISOString(),
    });
    // A visitor and a reader without the tier get no signed path, and no path at all.
    for (const as of [visitor(), bob.as]) {
      const answer = await read('beeld', as);
      expect(answer.readerMedia).toBeUndefined();
      expect(JSON.stringify(answer)).not.toContain('sig=');
    }
    const answer = await read('beeld', ada.as);
    // Only the restricted ones, each file signed for this tenant, item and locale.
    expect(Object.keys(answer.readerMedia ?? {}).sort()).toEqual([hero.id, inside.id].sort());
    const signed = answer.readerMedia![inside.id]!;
    expect(signed.variants.length).toBeGreaterThan(0);
    const scope = readerMediaScope(TENANT, item.id, 'nl');
    for (const v of signed.variants) {
      const url = new URL(v.path, 'https://site.example');
      expect(url.searchParams.get('for')).toBe(scope);
      // The grant ends before the ten minutes do, so the path ends with it.
      expect(Number(url.searchParams.get('exp'))).toBe(Math.floor(ends.getTime() / 1000));
    }
    const first = new URL(signed.variants[0]!.path, 'https://site.example');
    const opens = (at: Date, as = scope) =>
      verifyMediaSignature(
        uow.signer,
        inside.id,
        first.pathname.split('/').pop()!,
        first.searchParams.get('exp'),
        first.searchParams.get('sig'),
        at,
        as
      );
    expect(await opens(clock.now())).toBe(true);
    expect(await opens(clock.now(), readerMediaScope(OTHER, item.id, 'nl'))).toBe(false);
    expect(await opens(ends)).toBe(false);
    // A grant without an end: ten minutes at most.
    await invoker.run(useCases.createAccessGrant, admin(), {
      supporterId: bob.supporterId,
      tierId: t.id,
      kind: 'comp',
      reason: 'test',
    });
    const later = await read('beeld', bob.as);
    const exp = new URL(later.readerMedia![hero.id]!.variants[0]!.path, 'https://x').searchParams;
    expect(Number(exp.get('exp')) * 1000).toBe(clock.now().getTime() + READER_MEDIA_TTL_MS);
  });

  it('reads a revoked grant, a signed-out session and an ended session as closed', async () => {
    const t = await tier('donateurs');
    await article('stuk', { level: 'tier', tierIds: [t.id], teaser: 'marker' });
    const [ada, bob, cy] = [
      await reader('ada@example.org'),
      await reader('bob@example.org'),
      await reader('cy@example.org'),
    ];
    for (const r of [ada, bob, cy])
      await invoker.run(useCases.createAccessGrant, admin(), {
        supporterId: r.supporterId,
        tierId: t.id,
        kind: 'comp',
        reason: 'test',
      });
    clock.advance(1000);
    await invoker.run(useCases.revokeAccessGrant, admin(), {
      supporterId: ada.supporterId,
      tierId: t.id,
      reason: 'test',
    });
    expect((await read('stuk', ada.as)).gate).toEqual({ prompt: 'tier' });
    await invoker.run(useCases.signoutReader, bob.as, {});
    expect((await read('stuk', bob.as)).gate).toEqual({ prompt: 'signin' });
    clock.advance(12 * HOUR);
    expect((await read('stuk', cy.as)).gate).toEqual({ prompt: 'signin' });
  });

  it('gives an operator, a key and a system job no reader identity', async () => {
    await article('leden', { level: 'members', teaser: 'marker' });
    const key: Principal = {
      ...principal(),
      actor: { kind: 'api-key', keyId: 'k1' },
      capabilities: ['tenant:admin'],
    };
    for (const caller of [principal(), key, admin()]) {
      const answer = await read('leden', caller);
      expect(answer.gate).toEqual({ prompt: 'signin' });
      expect(hidden(answer)).toEqual([]);
    }
  });

  it('keeps a session of one tenant from opening another tenant', async () => {
    const mine = await tier('donateurs');
    const theirs = await tier('donateurs', OTHER);
    await article('stuk', { level: 'tier', tierIds: [mine.id], teaser: 'marker' });
    await article('stuk', { level: 'tier', tierIds: [theirs.id], teaser: 'marker' }, {}, OTHER);
    const ada = await reader('ada@example.org');
    await invoker.run(useCases.createAccessGrant, admin(), {
      supporterId: ada.supporterId,
      tierId: mine.id,
      kind: 'comp',
      reason: 'test',
    });
    expect((await read('stuk', ada.as)).gate).toBeNull();
    // The same session id presented on the other site names no session there.
    const elsewhere = await read('stuk', readerPrincipal(OTHER, ada.sessionId));
    expect(elsewhere.gate).toEqual({ prompt: 'signin' });
    expect(hidden(elsewhere)).toEqual([]);
  });

  it('lists and links a restricted item as its teaser card, the same for a reader with access', async () => {
    const t = await tier('donateurs');
    const item = await article('stuk', { level: 'tier', tierIds: [t.id], teaser: 'marker' });
    const ada = await reader('ada@example.org');
    await invoker.run(useCases.createAccessGrant, admin(), {
      supporterId: ada.supporterId,
      tierId: t.id,
      kind: 'comp',
      reason: 'test',
    });
    const card = { title: 'Titel', summary: 'De lead.', restricted: true };
    const answers = [];
    for (const as of [visitor(), ada.as]) {
      const overview = await invoker.run(useCases.getOverview, as, { props: {}, locale: 'nl' });
      expect(overview.entries).toEqual([expect.objectContaining(card)]);
      const feed = await invoker.run(useCases.getFeed, as, { locale: 'nl' });
      expect(feed.entries).toEqual([expect.objectContaining(card)]);
      const person = await invoker.run(useCases.getPublicPerson, as, {
        slug: 'sam-stuk',
        locale: 'nl',
      });
      expect(person.articles).toEqual([
        expect.objectContaining({ title: 'Titel', lead: 'De lead.', access: 'tier' }),
      ]);
      answers.push([overview, feed, person]);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(hidden(answers)).toEqual([]);
    // A link to it is a link in the published locale only (ADR 016 rule 3).
    const path = (locale: string) =>
      uow.run(visitor(), (ctx) => publicItemPath(ctx, item.id, locale, 'nl'));
    expect([await path('nl'), await path('en')]).toEqual(['/articles/stuk', null]);
  });

  it('leaves a restricted event without its when and where', async () => {
    const { item, revision } = await invoker.run(useCases.createItem, admin(), {
      slug: 'avond',
      profile: 'event',
      document: {
        type: 'page',
        profile: 'event',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Ledenavond' },
        lead: { nl: 'Voor leden.' },
        event: {
          startsAt: '2026-12-05T20:00',
          location: { nl: 'SENTINEL-PLACE' },
          onlineUrl: 'https://sentinel-meeting.example.org/room',
        },
        blocks: [rich('body', 'SENTINEL-BODY')].map((b) => ({
          ...b,
          props: { content: { nl: b.props.content.nl } },
        })),
        access: { level: 'members', teaser: 'lead' },
      } as never,
    } as never);
    await invoker.run(useCases.publishItem, admin(), {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    const answer = await read('avond', visitor(), 'page');
    expect(answer.event).toBeUndefined();
    expect(hidden(answer)).toEqual([]);
    const ada = await reader('ada@example.org');
    expect((await read('avond', ada.as, 'page')).event?.location).toBe('SENTINEL-PLACE');
    // An agenda sorts by when, so it leaves a restricted event out altogether.
    for (const when of ['upcoming', 'past'] as const) {
      const agenda = await invoker.run(useCases.getOverview, visitor(), {
        props: { source: 'event', when },
        locale: 'nl',
      });
      expect(agenda.entries).toEqual([]);
    }
  });

  it('shows nothing for a marker teaser that lost its boundary', () => {
    const doc = { access: { level: 'members', teaser: 'marker' }, blocks: [rich('body', 'x')] };
    expect(teaserBlocks(doc as never)).toEqual([]);
    expect(teaserDocument({ type: 'article', ...doc, corrections: [{}] } as never)).toMatchObject({
      blocks: [],
      corrections: [],
    });
  });
});
