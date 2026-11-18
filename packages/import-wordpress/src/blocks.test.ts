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

function run(content: string) {
  const notes: { code: NoteCode; detail?: string }[] = [];
  const ctx: MapContext = {
    locale: 'nl',
    postTitle: 'Bericht',
    link: linkRewriter('https://site.example', (path) => (path === '/over' ? ITEM : null)),
    media: (id) => MEDIA[Number(id)] ?? null,
    item: (id) => (Number(id) === 9 ? ITEM : null),
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
    // Without alt in the block or on the file the image is left out and reported.
    expect(
      run('<!-- wp:image {"id":2} --><figure><img src="x.jpg" alt=""/></figure><!-- /wp:image -->')
        .mapped
    ).toEqual({ kind: 'skip', reason: 'alt-missing' });
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
    expect((block.props.images as { mediaId: string }[]).map((i) => i.mediaId)).toEqual([
      MEDIA[1]!.ref,
      MEDIA[3]!.ref,
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
    expect(run('<!-- wp:wings/nodes-grid {"count":3} /-->').mapped).toEqual({
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
