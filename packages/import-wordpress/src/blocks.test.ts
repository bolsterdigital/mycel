import { BLOCK_DEFINITIONS } from '@mycel/core';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_MAP,
  mapBlock,
  videoOf,
  type MapContext,
  type Mapped,
  type NoteCode,
} from './blocks.js';
import { parseBlocks } from './grammar.js';
import { linkRewriter } from './rich.js';

const MEDIA: Record<number, { ref: string; alt: string | null; title: string }> = {
  1: { ref: '00000000-0000-4000-8001-000000000001', alt: 'Een plein vol mensen', title: 'Plein' },
  2: { ref: '00000000-0000-4000-8001-000000000002', alt: null, title: 'Zonder alt' },
  3: { ref: '00000000-0000-4000-8001-000000000003', alt: 'Een zaal', title: 'Zaal' },
};
const ITEM = '00000000-0000-4000-8004-000000000009';
/** Posts 9 to 16 are in the export; 9 is `ITEM`. */
const POST = (n: number) => `00000000-0000-4000-8004-0000000000${String(n).padStart(2, '0')}`;
const SECTION = '00000000-0000-4000-8003-000000000004';
const CAMPAIGN = '00000000-0000-4000-8007-000000000070';
const PERSON = (n: number) => `00000000-0000-4000-8005-00000000000${n}`;
const GROUP = '00000000-0000-4000-8006-000000000075';

function run(content: string) {
  const notes: { code: NoteCode; detail?: string }[] = [];
  const ctx: MapContext = {
    locale: 'nl',
    postTitle: 'Bericht',
    link: linkRewriter('https://site.example', (path) => (path === '/over' ? ITEM : null)),
    media: (id) => MEDIA[Number(id)] ?? null,
    item: (id) => (Number(id) >= 9 && Number(id) <= 16 ? POST(Number(id)) : null),
    person: (id) => ([1, 2, 3].includes(Number(id)) ? PERSON(Number(id)) : null),
    personGroup: (id) => (Number(id) === 75 ? GROUP : null),
    everyone: (kind) => (kind === 'person' ? [PERSON(2), PERSON(1)] : [PERSON(3)]),
    wingsNode: (id) => (id === 'w12' ? POST(12) : null),
    section: (id) => (Number(id) === 4 ? SECTION : null),
    dossier: (id) => (Number(id) === 40 ? POST(10) : null),
    campaign: (id) => (Number(id) === 70 ? CAMPAIGN : null),
    note: (code, detail) => notes.push({ code, ...(detail && { detail }) }),
  };
  const [block] = parseBlocks(content);
  return { mapped: mapBlock(block!, ctx), notes };
}

/** The one block a mapping made, validated against the core's schema for its type. */
function only(mapped: Mapped) {
  expect(mapped.kind).toBe('blocks');
  if (mapped.kind !== 'blocks') throw new Error('no blocks');
  expect(mapped.blocks).toHaveLength(1);
  const [block] = mapped.blocks;
  const parsed = BLOCK_DEFINITIONS[block!.type].props.safeParse(block!.props);
  expect(parsed.error?.issues ?? []).toEqual([]);
  return block!;
}

// One case per entry of the translation table (brief wordpress-import-execution § 5); the last
// test fails when an entry has no case here.
const CASES: Record<string, () => void> = {
  'core/paragraph': () => {
    const block = only(
      run(
        '<!-- wp:paragraph --><p>Lees <a href="https://site.example/over/">dit</a> en <span style="color:red"><strong>let op</strong></span>.<br>Dag.</p><!-- /wp:paragraph -->'
      ).mapped
    );
    expect(block).toEqual({
      type: 'rich-text',
      props: {
        content: {
          nl: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Lees ' },
                  { type: 'text', text: 'dit', marks: [{ type: 'link', attrs: { itemId: ITEM } }] },
                  { type: 'text', text: ' en ' },
                  { type: 'text', text: 'let op', marks: [{ type: 'bold' }] },
                  { type: 'text', text: '.' },
                  { type: 'hard_break' },
                  { type: 'text', text: 'Dag.' },
                ],
              },
            ],
          },
        },
      },
    });
  },
  'core/list': () => {
    const block = only(
      run(
        '<!-- wp:list {"ordered":true} --><ol start="3"><!-- wp:list-item --><li>Een<ul><li>half</li></ul></li><!-- /wp:list-item --></ol><!-- /wp:list -->'
      ).mapped
    );
    const doc = (block.props.content as Record<string, { content: unknown[] }>).nl!;
    expect(doc.content[0]).toMatchObject({
      type: 'ordered_list',
      attrs: { start: 3 },
      content: [{ content: [{ type: 'paragraph' }, { type: 'bullet_list' }] }],
    });
  },
  'core/heading': () => {
    const block = only(
      run('<!-- wp:heading --><h2>Wat we <em>doen</em></h2><!-- /wp:heading -->').mapped
    );
    expect(block).toEqual({ type: 'heading', props: { text: { nl: 'Wat we doen' } } });
  },
  'core/image': () => {
    const block = only(
      run(
        '<!-- wp:image {"id":2,"align":"right"} --><figure><img src="x.jpg" alt="Een bos"/><figcaption>In mei</figcaption></figure><!-- /wp:image -->'
      ).mapped
    );
    expect(block.props).toEqual({
      mediaId: MEDIA[2]!.ref,
      decorative: false,
      alt: { nl: 'Een bos' },
      caption: { nl: 'In mei' },
      layout: 'float-right',
    });
    // Without alt in the block or on the file the image is placed with its alt missing (ADR 020
    // rule 3, 2026-11-22), and reported so an editor can describe it.
    const missing = run(
      '<!-- wp:image {"id":2} --><figure><img src="x.jpg" alt=""/></figure><!-- /wp:image -->'
    );
    expect(only(missing.mapped).props).toEqual({
      mediaId: MEDIA[2]!.ref,
      decorative: false,
      alt: null,
      layout: 'content',
    });
    expect(missing.notes).toEqual([{ code: 'image.alt-missing', detail: '2' }]);
    expect(run('<!-- wp:image {"id":99} --><img alt="a"/><!-- /wp:image -->').mapped).toEqual({
      kind: 'skip',
      reason: 'media-missing',
    });
  },
  'wings/image': () => {
    const block = only(run('<!-- wp:wings/image {"id":1,"layout":"full"} /-->').mapped);
    // The file's alt text fills an empty one in the block.
    expect(block.props).toMatchObject({ alt: { nl: 'Een plein vol mensen' }, layout: 'full' });
    const decorative = only(run('<!-- wp:wings/image {"id":2,"decorative":true} /-->').mapped);
    expect(decorative.props).toMatchObject({ decorative: true, alt: null });
  },
  'core/gallery': () => {
    const { mapped, notes } = run(
      '<!-- wp:gallery --><figure><!-- wp:image {"id":1} --><figure><img alt=""/></figure><!-- /wp:image --><!-- wp:image {"id":2} --><figure><img alt=""/></figure><!-- /wp:image --><!-- wp:image {"id":3} --><figure><img alt="Zaal"/></figure><!-- /wp:image --></figure><!-- /wp:gallery -->'
    );
    const block = only(mapped);
    // Every image is placed; the one without alt anywhere has its alt missing and is reported.
    expect(
      (block.props.images as { mediaId: string; alt: unknown }[]).map((i) => [i.mediaId, i.alt])
    ).toEqual([
      [MEDIA[1]!.ref, { nl: 'Een plein vol mensen' }],
      [MEDIA[2]!.ref, null],
      [MEDIA[3]!.ref, { nl: 'Zaal' }],
    ]);
    expect(notes).toEqual([{ code: 'image.alt-missing', detail: '2' }]);
    // Before WordPress 5.9: the ids in the attributes.
    expect(only(run('<!-- wp:gallery {"ids":[1,3]} /-->').mapped).type).toBe('gallery');
  },
  'wings/image-gallery': () => {
    const block = only(
      run(
        '<!-- wp:wings/image-gallery {"images":[{"id":1,"alt":"","caption":"Op het plein"},{"id":3,"alt":"Volle zaal"}]} /-->'
      ).mapped
    );
    expect(block.props.images).toEqual([
      expect.objectContaining({
        alt: { nl: 'Een plein vol mensen' },
        caption: { nl: 'Op het plein' },
      }),
      expect.objectContaining({ alt: { nl: 'Volle zaal' } }),
    ]);
  },
  'wings/privacy-video': () => {
    const { mapped, notes } = run(
      '<!-- wp:wings/privacy-video {"provider":"youtube","videoId":"dQw4w9WgXcQ"} /-->'
    );
    expect(only(mapped).props).toEqual({
      provider: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      title: { nl: 'Bericht' },
    });
    expect(notes).toEqual([{ code: 'video.title-from-item' }]);
  },
  'core/embed': () => {
    const { mapped, notes } = run(
      '<!-- wp:embed {"url":"https://player.vimeo.com/video/76979871"} --><figure><div>x</div><figcaption>Het debat</figcaption></figure><!-- /wp:embed -->'
    );
    expect(only(mapped).props).toEqual({
      provider: 'vimeo',
      videoId: '76979871',
      title: { nl: 'Het debat' },
    });
    expect(notes).toEqual([]);
    expect(run('<!-- wp:embed {"url":"https://twitter.com/x/status/1"} /-->').mapped).toEqual({
      kind: 'skip',
      reason: 'unsupported',
    });
  },
  'core/quote': () => {
    const block = only(
      run(
        '<!-- wp:quote --><blockquote><!-- wp:paragraph --><p>Nu &amp; altijd.</p><!-- /wp:paragraph --><cite>De voorzitter</cite></blockquote><!-- /wp:quote -->'
      ).mapped
    );
    expect(block.props).toEqual({
      text: { nl: 'Nu & altijd.' },
      attribution: { name: 'De voorzitter' },
    });
  },
  'wings/blockquote': () => {
    const block = only(
      run(
        '<!-- wp:wings/blockquote {"quote":"Doorgaan.","source":"Anna","sourceUrl":"https://krant.example/a"} /-->'
      ).mapped
    );
    expect(block.props).toEqual({
      text: { nl: 'Doorgaan.' },
      attribution: { name: 'Anna', url: 'https://krant.example/a' },
    });
  },
  'wings/callout': () => {
    const block = only(
      run('<!-- wp:wings/callout {"content":"<p>Let <em>op</em>.</p>","emoji":"💡"} /-->').mapped
    );
    expect(block.type).toBe('callout');
  },
  'wings/cta': () => {
    const block = only(
      run(
        '<!-- wp:wings/cta {"title":"Steun ons","buttonText":"Lees","link":{"id":9},"secondaryButtonText":"Geef","secondaryUrl":"https://geef.example"} /-->'
      ).mapped
    );
    expect(block.props.actions).toEqual([
      { label: { nl: 'Lees' }, target: { kind: 'item', itemId: ITEM } },
      { label: { nl: 'Geef' }, target: { kind: 'url', url: 'https://geef.example' } },
    ]);
  },
  'wings/faq': () => {
    const block = only(
      run('<!-- wp:wings/faq {"faqItems":[{"question":"Wie?","answer":"<p>Iedereen.</p>"}]} /-->')
        .mapped
    );
    expect(block.props.entries).toHaveLength(1);
  },
  'wings/timeline': () => {
    const { mapped, notes } = run(
      '<!-- wp:wings/timeline {"events":[{"date":"2019","title":"Begin"},{"date":"2020-02-03","title":"Toen","description":"<p>Feest</p>"},{"date":"","title":"Ooit"}]} /-->'
    );
    expect(only(mapped).props.events).toEqual([
      { date: '2019-01-01', title: { nl: 'Begin' } },
      { date: '2020-02-03', title: { nl: 'Toen' }, body: { nl: 'Feest' } },
    ]);
    expect(notes.map((n) => n.code)).toEqual([
      'timeline.date-completed',
      'timeline.event-without-date',
    ]);
  },
  'wings/hero': () => {
    const { mapped, notes } = run(
      '<!-- wp:wings/hero {"introText":"Wij zijn er.","ctaText":"Kom","heroImage":{"id":1,"alt":""}} /-->'
    );
    expect(mapped).toEqual({
      kind: 'header',
      header: { lead: 'Wij zijn er.', heroImageId: MEDIA[1]!.ref, heroAlt: 'Een plein vol mensen' },
    });
    expect(notes).toEqual([{ code: 'hero.action-dropped', detail: 'Kom' }]);
  },
  'wings/people-organizations-grid': () => {
    // A category becomes its person group; the social links are the card's contact line.
    expect(
      only(
        run(
          '<!-- wp:wings/people-organizations-grid {"displayMode":"category","selectedCategory":"75","columns":4,"showSocialMedia":true} /-->'
        ).mapped
      ).props
    ).toEqual({
      source: 'group',
      groupId: GROUP,
      people: [],
      columns: '4',
      showRole: true,
      showBio: false,
      showContact: true,
    });
    // A selection keeps its order; an id outside the export is a note, a repeat is dropped.
    const picked = run(
      '<!-- wp:wings/people-organizations-grid {"contentType":"organizations","displayMode":"selected","selectedItems":[3,1,8,3],"columns":6,"showSocialMedia":false} /-->'
    );
    expect(only(picked.mapped).props).toEqual({
      source: 'selection',
      groupId: null,
      people: [{ personId: PERSON(3) }, { personId: PERSON(1) }],
      columns: '4',
      showRole: true,
      showBio: true,
      showContact: false,
    });
    expect(picked.notes).toEqual([{ code: 'people.missing', detail: '8' }]);
    // Without a mode Wings shows every entry of the kind, by title.
    expect(
      only(run('<!-- wp:wings/people-organizations-grid {"columns":1} /-->').mapped).props
    ).toMatchObject({ people: [{ personId: PERSON(2) }, { personId: PERSON(1) }], columns: '2' });
    expect(
      run(
        '<!-- wp:wings/people-organizations-grid {"displayMode":"category","selectedCategory":"9"} /-->'
      ).mapped
    ).toEqual({ kind: 'skip', reason: 'people-missing' });
  },
  'wings/nodes-grid': () => {
    // A custom selection stays fixed: seven in order (a repeat once), one outside the export noted.
    const custom = run(
      '<!-- wp:wings/nodes-grid {"selectedNodes":[16,9,12,99,10,15,12,11,13],"wingsNodeIds":["a"],"columns":3,"title":"Onze mensen","description":"Zij doen het werk."} /-->'
    );
    expect(custom.mapped.kind).toBe('blocks');
    const [heading, intro, list] = (custom.mapped as { blocks: { type: string; props: unknown }[] })
      .blocks;
    expect(heading).toEqual({ type: 'heading', props: { text: { nl: 'Onze mensen' } } });
    expect(JSON.stringify(intro)).toContain('Zij doen het werk.');
    expect(list).toEqual({
      type: 'overview',
      props: {
        layout: 'cards',
        width: 'wide',
        source: 'selection',
        pinned: [16, 9, 12, 10, 15, 11, 13].map((n) => ({ itemId: POST(n) })),
      },
    });
    expect(BLOCK_DEFINITIONS.overview.props.safeParse(list!.props).success).toBe(true);
    expect(custom.notes).toEqual([{ code: 'items.missing', detail: '99' }]);
    // The newest articles, of the section made from the category; the "all" link has no page.
    const latest = run(
      '<!-- wp:wings/nodes-grid {"variationType":"latest","latestPostsCount":3,"selectedCategory":4} /-->'
    );
    expect(only(latest.mapped).props).toEqual({
      layout: 'cards',
      width: 'wide',
      source: 'article',
      order: 'newest',
      limit: '3',
      sectionId: SECTION,
    });
    expect(latest.notes).toEqual([{ code: 'overview.more-dropped', detail: 'category' }]);
    expect(
      only(run('<!-- wp:wings/nodes-grid {"variationType":"latest"} /-->').mapped).props
    ).toMatchObject({ source: 'article', limit: '4', sectionId: null });
    expect(
      only(
        run('<!-- wp:wings/nodes-grid {"variationType":"events","latestPostsCount":2} /-->').mapped
      ).props
    ).toMatchObject({ source: 'event', when: 'upcoming', limit: '2' });
    // A dossier grid lists the dossier page's members (MY-290); "all" is two overviews.
    const grid = (attrs: string) =>
      run(`<!-- wp:wings/nodes-grid {"variationType":"dossier",${attrs}} /-->`);
    const pages = grid('"selectedDossier":40,"dossierPostType":"page"');
    expect(only(pages.mapped).props).toMatchObject({ source: 'page', dossierId: POST(10) });
    expect(pages.notes).toEqual([]);
    const all = grid('"selectedDossier":40');
    expect(all.mapped.kind === 'blocks' && all.mapped.blocks.map((b) => b.props.source)).toEqual([
      'article',
      'page',
    ]);
    expect(all.notes).toEqual([{ code: 'overview.dossier-split' }]);
    expect(grid('"selectedDossier":7').mapped).toEqual({ kind: 'skip', reason: 'items-missing' });
    // Without `selectedNodes` the old Wings ids, through the posts that carry them.
    expect(
      only(run('<!-- wp:wings/nodes-grid {"selectedNodes":[],"wingsNodeIds":["w12"]} /-->').mapped)
        .props
    ).toMatchObject({ pinned: [{ itemId: POST(12) }] });
    const gone = run('<!-- wp:wings/nodes-grid {"selectedNodes":[],"wingsNodeIds":["x1"]} /-->');
    expect(gone).toEqual({
      mapped: { kind: 'skip', reason: 'items-missing' },
      notes: [{ code: 'items.missing', detail: 'x1' }],
    });
  },
  'wings/single-node': () => {
    const one = run('<!-- wp:wings/single-node {"postId":12,"postTitle":"Een stuk"} /-->');
    expect(only(one.mapped).props).toMatchObject({
      source: 'selection',
      pinned: [{ itemId: POST(12) }],
    });
    expect(run('<!-- wp:wings/single-node {"postId":99} /-->')).toEqual({
      mapped: { kind: 'skip', reason: 'items-missing' },
      notes: [{ code: 'items.missing', detail: '99' }],
    });
  },
  'wings/campaign-card': () => {
    // A live reference to the campaign the action became (MY-291); `full` is the default style.
    const card = (attrs: string) => run(`<!-- wp:wings/campaign-card {${attrs}} /-->`);
    expect(only(card('"campaignId":70,"campaignType":"petition"').mapped)).toEqual({
      type: 'campaign-card',
      props: { campaignId: CAMPAIGN, variant: 'full' },
    });
    expect(only(card('"campaignId":70,"displayStyle":"compact"').mapped).props.variant).toBe(
      'compact'
    );
    const missing = card('"campaignId":71,"campaignType":"signup"');
    expect(missing.mapped).toEqual({ kind: 'skip', reason: 'items-missing' });
    expect(missing.notes).toEqual([{ code: 'items.missing', detail: 'campaign 71' }]);
  },
  'wings/action-cards': () => {
    const card = (title: string, url = '') =>
      `<!-- wp:wings/action-card {"title":"${title}","text":"Tekst ${title}.","buttonText":"Doe mee","url":"${url}"} /-->`;
    const three = only(
      run(
        `<!-- wp:wings/action-cards {"band":true} --><div>${card('Word lid', 'https://site.example/over/')}${card('Doneer', 'https://elders.example/geef')}${card('Kom')}</div><!-- /wp:wings/action-cards -->`
      ).mapped
    );
    expect(three.type).toBe('cards');
    expect(three.props).toMatchObject({
      accent: 'filled',
      cards: [
        { title: { nl: 'Word lid' }, actions: [{ target: { kind: 'item', itemId: ITEM } }] },
        { actions: [{ target: { kind: 'url', url: 'https://elders.example/geef' } }] },
        { body: { nl: 'Tekst Kom.' }, actions: [] },
      ],
    });
    expect(
      only(
        run(
          `<!-- wp:wings/action-cards --><div>${card('Alleen', 'https://elders.example')}</div><!-- /wp:wings/action-cards -->`
        ).mapped
      ).type
    ).toBe('cta');
    const bare = run(
      `<!-- wp:wings/action-cards --><div>${card('Zonder knop')}</div><!-- /wp:wings/action-cards -->`
    ).mapped as { blocks: { type: string }[] };
    expect(bare.blocks.map((b) => b.type)).toEqual(['heading', 'rich-text']);
  },
  'core/file': () => {
    const block = only(
      run(
        '<!-- wp:file {"id":3} --><div><a href="x.pdf">Jaarverslag</a><a href="x.pdf" download>Download</a></div><!-- /wp:file -->'
      ).mapped
    );
    expect(block.props).toEqual({
      files: [{ fileId: MEDIA[3]!.ref, name: { nl: 'Jaarverslag' } }],
    });
  },
  'core/audio': () => {
    const block = only(
      run(
        '<!-- wp:audio {"id":3} --><figure><audio src="x.mp3"></audio></figure><!-- /wp:audio -->'
      ).mapped
    );
    // No caption: the file's title.
    expect(block.props).toEqual({ title: { nl: 'Zaal' }, fileId: MEDIA[3]!.ref });
  },
  'core/shortcode': () => {
    expect(run('<!-- wp:shortcode -->[form id="1"]<!-- /wp:shortcode -->').mapped).toEqual({
      kind: 'skip',
      reason: 'shortcode',
    });
  },
};

describe('the block translation table', () => {
  it.each(Object.keys(CASES))('maps %s', (name) => CASES[name]!());

  it('has a case for every entry', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(BLOCK_MAP).sort());
  });

  it('leaves out a block it has no entry for, and a paragraph that is only a shortcode', () => {
    expect(run('<!-- wp:wings/onbekend {"count":3} /-->').mapped).toEqual({
      kind: 'skip',
      reason: 'unsupported',
    });
    expect(
      run('<!-- wp:paragraph --><p>[gallery ids="1,2"]</p><!-- /wp:paragraph -->').mapped
    ).toEqual({ kind: 'skip', reason: 'shortcode' });
  });

  it('reads classic-editor HTML as paragraphs', () => {
    const block = only(run('Eerste regel\nmet een breuk\n\nTweede alinea').mapped);
    const doc = (block.props.content as Record<string, { content: unknown[] }>).nl!;
    expect(doc.content).toHaveLength(2);
  });

  it('knows the YouTube and Vimeo addresses', () => {
    expect(videoOf('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      provider: 'youtube',
      videoId: 'dQw4w9WgXcQ',
    });
    expect(videoOf('https://www.youtube.com/embed/dQw4w9WgXcQ')?.videoId).toBe('dQw4w9WgXcQ');
    expect(videoOf('https://vimeo.com/123')).toEqual({ provider: 'vimeo', videoId: '123' });
    expect(videoOf('https://youtube.com/watch?v=short')).toBeNull();
    expect(videoOf('not a url')).toBeNull();
  });
});
