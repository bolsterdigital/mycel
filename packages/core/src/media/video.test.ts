import { describe, expect, it, vi } from 'vitest';
import {
  buildRegistry,
  DEFAULT_INTEGRATIONS,
  grantVideo,
  Invoker,
  videoPresentation,
  readVideoTrack,
  systemPrincipal,
  useCases,
  videoSourceKey,
  type VideoProvider,
} from '../index.js';
import { expectCode, FakeClock, MemoryUnitOfWork, TENANT } from '../testing/index.js';
import { EXAMPLE_PNG } from './service.js';
import { runVideoCreate } from './video-service.js';

const providerId = 'f7f0cef5-0500-4ac4-a43c-63108f5d4b18';
const intentId = '039d7e18-89ae-4597-ab00-aeec8519cda6';
const otherTenant = '21aef377-07fe-40fb-b06e-d266d2428606';
const source = Uint8Array.of(1, 2, 3);
const cues = 'WEBVTT\n\n00:00.000 --> 00:02.000\nRiver\n';

async function fixture() {
  const provider: VideoProvider = {
    libraryId: '123',
    playbackOrigin: 'https://tenant.b-cdn.net',
    create: vi.fn(async () => providerId),
    find: vi.fn(async () => providerId),
    status: vi.fn(async () => ({
      state: 'upload' as const,
      durationSeconds: 0,
      storageBytes: 0,
      mp4Height: null,
    })),
    signUpload: vi.fn(() => ({ signature: 'tus-grant', expires: 3000 })),
    signPlayback: vi.fn(() => ({
      hls: 'https://tenant.b-cdn.net/playlist.m3u8',
      mp4: 'https://tenant.b-cdn.net/fallback.mp4',
    })),
    retainSource: vi.fn(async (_id, key, blobs) => {
      await blobs.put(key, source, { contentType: 'video/mp4' });
    }),
  };
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ videoProvider: provider, clock });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(TENANT, 'video-test');
  const { id: posterId } = await invoker.run(useCases.uploadMedia, admin, {
    filename: 'poster.png',
    contentType: 'image/png',
    bytes: EXAMPLE_PNG,
  });
  const input = {
    posterId,
    uploadKey: intentId,
    sizeBytes: 3000,
    durationSeconds: 10,
    title: { nl: 'Opname', en: 'Recording' },
    maker: 'Mycel',
    licence: { code: 'own-work' as const },
    watchUrl: 'https://example.org/recording',
  };
  return { provider, uow, invoker, admin, input, clock };
}

describe('managed video', () => {
  it('commits one reservation and reconciles an ambiguous create without repeating the write', async () => {
    const { provider, uow, invoker, admin, input } = await fixture();
    const [first, second] = await Promise.all([
      invoker.run(useCases.createVideo, admin, input),
      invoker.run(useCases.createVideo, admin, input),
    ]);
    expect(first).toEqual(second);
    expect(await uow.run(admin, (ctx) => ctx.videos.usage())).toEqual({
      storageBytes: 3000,
      durationSeconds: 10,
    });
    vi.mocked(provider.create).mockRejectedValueOnce(new Error('lost reply'));
    await expect(runVideoCreate(uow, admin, first.id)).rejects.toThrow('lost reply');
    await runVideoCreate(uow, admin, first.id);
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.find).toHaveBeenCalledWith(first.id);
    expect(await invoker.run(useCases.resumeVideo, admin, { id: first.id })).toMatchObject({
      libraryId: '123',
      videoId: providerId,
      signature: 'tus-grant',
    });
    await expectCode(
      invoker.run(useCases.resumeVideo, systemPrincipal(otherTenant, 'other'), { id: first.id }),
      'not_found'
    );
  });

  it('accounts for provider totals and retains a completed source even when limits prevent placement', async () => {
    const { provider, uow, invoker, admin, input } = await fixture();
    const video = await invoker.run(useCases.createVideo, admin, input);
    await runVideoCreate(uow, admin, video.id);
    vi.mocked(provider.status).mockResolvedValue({
      state: 'complete',
      durationSeconds: 240,
      storageBytes: 9500,
      mp4Height: 360,
    });
    const limited = {
      ...admin,
      entitlements: { ...admin.entitlements, 'video.stored_max_minutes': 1 },
    };
    expect(await invoker.run(useCases.checkVideo, limited, { id: video.id })).toMatchObject({
      state: 'over-limit',
      durationSeconds: 240,
    });
    const key = videoSourceKey(admin.tenantId, video.id);
    expect(await uow.blobs.get(key)).toEqual(source);
    expect(await uow.run(admin, (ctx) => ctx.videos.usage())).toEqual({
      storageBytes: 9500,
      durationSeconds: 240,
    });
    await expectCode(invoker.run(useCases.resumeVideo, admin, { id: video.id }), 'conflict');
  });

  it('grants the current public placement and its track, and holds old references for trash', async () => {
    const { provider, uow, invoker, admin, input, clock } = await fixture();
    const video = await invoker.run(useCases.createVideo, admin, input);
    await runVideoCreate(uow, admin, video.id);
    vi.mocked(provider.status).mockResolvedValue({
      state: 'complete',
      durationSeconds: 10,
      storageBytes: 4300,
      mp4Height: 360,
    });
    await invoker.run(useCases.checkVideo, admin, { id: video.id });
    uow.store.for(TENANT).videos.get(video.id)!.publishedTracks.en = cues;
    const settings = await invoker.run(useCases.updateIntegrationSettings, admin, {
      baseVersion: 0,
      settings: { ...DEFAULT_INTEGRATIONS, 'bunny-stream': { enabled: true } },
    });
    const target = { type: 'page' as const, slug: 'river-video', locale: 'en', block: 'recording' };
    const { item: draft, revision } = await invoker.run(useCases.createItem, admin, {
      slug: target.slug,
      document: {
        type: target.type,
        defaultLocale: 'en',
        locales: ['en'],
        title: { en: 'River video' },
        blocks: [{ id: target.block, type: 'video', version: 1, props: { videoId: video.id } }],
      },
    });
    const grant = () => uow.run(admin, (ctx) => grantVideo(ctx, target));
    expect(await grant()).toBeNull();
    await invoker.run(useCases.publishItem, admin, {
      itemId: draft.id,
      revisionId: revision.id,
      locale: target.locale,
    });
    const opened = await grant();
    expect(opened).toMatchObject({ title: 'Recording', track: { signature: expect.any(String) } });
    const { expires, signature } = opened!.track!;
    const track = () => uow.run(admin, (ctx) => readVideoTrack(ctx, target, expires, signature));
    expect(await track()).toBe(cues);
    // Chapters (MY-305) only with published chapters, signed apart: neither signature opens the
    // other track.
    expect(opened!.chapters).toBeNull();
    const chapterCues = 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nOpening';
    uow.store.for(TENANT).videos.get(video.id)!.publishedChapters = { en: chapterCues };
    const chaptered = (await grant())!;
    const read = (sig: { expires: number; signature: string }, kind: 'captions' | 'chapters') =>
      uow.run(admin, (ctx) => readVideoTrack(ctx, target, sig.expires, sig.signature, kind));
    expect(await read(chaptered.chapters!, 'chapters')).toBe(chapterCues);
    expect(await read(chaptered.chapters!, 'captions')).toBeNull();
    expect(await read(chaptered.track!, 'chapters')).toBeNull();
    const transcript = { id: video.id, locale: target.locale };
    const current = await invoker.run(useCases.getTranscript, admin, transcript);
    const draftTrack = await invoker.run(useCases.saveTranscript, admin, {
      ...transcript,
      version: current.version,
      source: '1\n00:00:00,000 --> 00:00:02,000\nOttersporen gevonden.',
    });
    const search = (q: string, principal = admin) =>
      invoker.run(useCases.findPublished, principal, { q, locale: 'en' });
    expect((await search('ottersporen')).items).toHaveLength(0);
    expect(await track()).toBe(cues);
    await expectCode(
      invoker.run(useCases.publishTranscript, admin, { ...transcript, version: current.version }),
      'conflict'
    );
    await expectCode(
      invoker.run(
        useCases.publishTranscript,
        {
          ...admin,
          actor: { kind: 'operator', operatorId: intentId },
          capabilities: ['media:write'],
        },
        { ...transcript, version: draftTrack.version }
      ),
      'forbidden'
    );
    await invoker.run(useCases.publishTranscript, admin, {
      ...transcript,
      version: draftTrack.version,
    });
    expect(await track()).toBeNull();
    expect((await search('ottersporen')).items[0]?.excerpt).toContainEqual({
      text: 'Ottersporen',
      match: true,
    });
    expect((await search('ottersporen', systemPrincipal(otherTenant, 'other'))).items).toHaveLength(
      0
    );
    const published = (await grant())!.track!;
    expect(
      await uow.run(admin, (ctx) =>
        readVideoTrack(ctx, target, published.expires, published.signature)
      )
    ).toBe(draftTrack.source);
    expect(
      await uow.run(systemPrincipal(otherTenant, 'other'), (ctx) => grantVideo(ctx, target))
    ).toBeNull();
    expect(opened!.expires - opened!.issued).toBe(900);
    clock.advance(900_000);
    expect(await track()).toBeNull();
    const renewed = await grant();
    expect(renewed?.expires).toBe(expires + 900);
    expect(await uow.run(admin, (ctx) => grantVideo(ctx, { ...target, locale: 'nl' }))).toBeNull();
    await invoker.run(useCases.unpublishItem, admin, { itemId: draft.id, locale: target.locale });
    expect(await grant()).toBeNull();
    expect((await search('ottersporen')).items).toHaveLength(0);
    expect(await track()).toBeNull();
    await invoker.run(useCases.publishItem, admin, {
      itemId: draft.id,
      revisionId: revision.id,
      locale: target.locale,
    });
    expect(await grant()).not.toBeNull();
    await invoker.run(useCases.updateIntegrationSettings, admin, {
      baseVersion: settings.version,
      settings: DEFAULT_INTEGRATIONS,
    });
    expect(await grant()).toBeNull();
    expect((await search('ottersporen')).items).toHaveLength(0);
    expect(await track()).toBeNull();
    await invoker.run(useCases.unpublishItem, admin, { itemId: draft.id, locale: target.locale });
    await expectCode(invoker.run(useCases.deleteVideo, admin, { id: video.id }), 'conflict');
  });

  it('saves chapters in the draft beside the transcript and publishes them with it (MY-305)', async () => {
    const { provider, uow, invoker, admin, input } = await fixture();
    const video = await invoker.run(useCases.createVideo, admin, input);
    await runVideoCreate(uow, admin, video.id);
    vi.mocked(provider.status).mockResolvedValue({
      state: 'complete',
      durationSeconds: 600,
      storageBytes: 4300,
      mp4Height: 360,
    });
    await invoker.run(useCases.checkVideo, admin, { id: video.id });
    const target = { id: video.id, locale: 'nl' };
    const shown = async () =>
      (await uow.run(admin, (ctx) => videoPresentation(ctx, video.id, 'nl')))!.chapters;
    const empty = await invoker.run(useCases.getTranscript, admin, target);
    expect(empty.chapters).toBe('');

    const saved = await invoker
      .run(useCases.saveTranscript, admin, {
        ...target,
        version: empty.version,
        source: '0:00 Welkom.',
        chapters: '0:00 Opening\n3:10 Wie is Tim\n1:02.5 te vroeg',
      })
      .catch((e: unknown) => e);
    // Out of order: nothing of the save is kept, the transcript neither.
    expect(saved).toMatchObject({ code: 'invalid_input' });
    expect((await invoker.run(useCases.getTranscript, admin, target)).source).toBe('');

    const draft = await invoker.run(useCases.saveTranscript, admin, {
      ...target,
      version: empty.version,
      source: '0:00 Welkom.',
      chapters: '\uFEFF0:00 Opening\r\n3:10 Wie is Tim\r\n9:59.5 Afsluiting',
    });
    expect(draft.chapters).toBe('0:00 Opening\n3:10 Wie is Tim\n9:59.500 Afsluiting');
    expect(draft.published).toBe(false);
    expect(await shown()).toEqual([]);

    await invoker.run(useCases.publishTranscript, admin, { ...target, version: draft.version });
    expect(await shown()).toEqual([
      { start: 0, end: 190, title: 'Opening' },
      { start: 190, end: 599.5, title: 'Wie is Tim' },
      { start: 599.5, end: 600, title: 'Afsluiting' },
    ]);
    expect(await uow.run(admin, (ctx) => videoPresentation(ctx, video.id, 'en'))).toMatchObject({
      chapters: [],
    });

    // A save without chapters keeps them; an edit of the chapters alone is a new draft to publish.
    const live = await invoker.run(useCases.getTranscript, admin, target);
    expect(live.published).toBe(true);
    const kept = await invoker.run(useCases.saveTranscript, admin, {
      ...target,
      version: live.version,
      source: '0:00 Welkom.',
    });
    expect(kept).toMatchObject({ chapters: draft.chapters, published: true });
    const cleared = await invoker.run(useCases.saveTranscript, admin, {
      ...target,
      version: kept.version,
      source: '0:00 Welkom.',
      chapters: '',
    });
    expect(cleared).toMatchObject({ chapters: '', published: false });
    expect(cleared.version).not.toBe(kept.version);
    expect(await shown()).toHaveLength(3);
    await expectCode(
      invoker.run(useCases.saveTranscript, admin, {
        ...target,
        version: kept.version,
        source: '0:00 Welkom.',
        chapters: '1:00 Te laat',
      }),
      'conflict'
    );
    await invoker.run(useCases.publishTranscript, admin, { ...target, version: cleared.version });
    expect(await shown()).toEqual([]);
    // A chapter after the end of the recording is refused.
    await expectCode(
      invoker.run(useCases.saveTranscript, admin, {
        ...target,
        version: cleared.version,
        source: '0:00 Welkom.',
        chapters: '0:00 Opening\n10:01 Na afloop',
      }),
      'invalid_input'
    );
  });
});
