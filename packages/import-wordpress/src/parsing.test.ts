import { describe, expect, it } from 'vitest';
import { parseBlocks } from './grammar.js';
import { decodeEntities, parseMarkup, textOf } from './markup.js';
import { docFromHtml, linkRewriter, plainText } from './rich.js';
import { readWxr } from './wxr.js';

const noItems = () => null;
const link = linkRewriter('https://site.example', noItems);

describe('the block grammar', () => {
  it('reads nested, self-closing and freeform blocks with the core namespace written out', () => {
    const blocks = parseBlocks(
      'intro <!-- wp:group {"a":1} --><div><!-- wp:paragraph --><p>x</p><!-- /wp:paragraph --></div><!-- /wp:group -->\n\n<!-- wp:wings/hero {"title":"--x"} /--> outro'
    );
    expect(blocks.map((b) => b.name)).toEqual([null, 'core/group', 'wings/hero', null]);
    expect(blocks[1]).toMatchObject({ attrs: { a: 1 }, html: '<div><p>x</p></div>' });
    expect(blocks[1]!.innerBlocks.map((b) => b.name)).toEqual(['core/paragraph']);
    expect(blocks[2]!.attrs).toEqual({ title: '--x' });
  });

  it('gives an unclosed block the rest of the content and reads broken attributes as none', () => {
    const blocks = parseBlocks('<!-- wp:paragraph {nope} --><p>rest</p>');
    expect(blocks).toEqual([
      { name: 'core/paragraph', attrs: {}, innerBlocks: [], html: '<p>rest</p>' },
    ]);
  });
});

describe('markup', () => {
  it('decodes references and keeps an unknown one', () => {
    expect(decodeEntities('a &amp; b &#233; &#x2014; &bogus;')).toBe('a & b é — &bogus;');
  });

  it('closes what an unmatched closing tag skips and keeps CDATA as text', () => {
    const root = parseMarkup('<p>a<b>b</p>c</i><x><![CDATA[<y>]]></x>', 'xml');
    expect(textOf(root)).toBe('abc<y>');
  });
});

describe('rich text', () => {
  it('keeps headings from skipping a level and lists within three levels', () => {
    const doc = docFromHtml(
      '<h4>Diep</h4><ul><li>1<ul><li>2<ul><li>3<ul><li>4</li></ul></li></ul></li></ul></li></ul>',
      link
    )!;
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    const level3 = JSON.stringify(doc.content[1]);
    expect(level3).toContain('"text":"4"');
    expect(level3.match(/bullet_list/g)).toHaveLength(3);
  });

  it('drops a link the core refuses and keeps its words', () => {
    const doc = docFromHtml('<p><a href="javascript:alert(1)">klik</a></p>', link)!;
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'klik' }],
    });
  });

  it('makes a link into the old site a path, and leaves uploads where they are', () => {
    expect(link('https://site.example/agenda/?x=1')).toEqual({ href: '/agenda/?x=1' });
    expect(link('https://site.example/wp-content/uploads/a.pdf')).toEqual({
      href: 'https://site.example/wp-content/uploads/a.pdf',
    });
  });

  it('reads plain text with paragraph breaks', () => {
    expect(plainText('<p>Een  twee</p><p>drie<br>vier</p>')).toBe('Een twee\n\ndrie\nvier');
  });
});

describe('the WXR reader', () => {
  it('refuses a file that is not an export', () => {
    expect(() => readWxr('<html><body/></html>')).toThrow(/not a WordPress export/);
  });
});
