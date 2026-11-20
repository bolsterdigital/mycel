// One small tokenizer and tree builder for the two markups a WordPress export holds: the WXR file
// itself (XML with CDATA) and the HTML inside each post. Both need tags, attributes, text,
// comments, CDATA and entities, and nothing more; a block comment is read separately
// (`grammar.ts`). ADR 008 asks whether our own code covers a need in about two hundred lines
// before a dependency is taken, and this does. Rejected: `fast-xml-parser` for the WXR (a
// dependency for a file format that has not changed in a decade) and an HTML5 parser such as
// parse5 (the post HTML comes from the block editor, which writes well-formed markup; a stray
// unmatched tag is skipped rather than repaired).

export interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}
export type Node = Element | string;

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  euro: '€',
};

/** Decode character references; an unknown named one stays as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** HTML elements that never have content or a closing tag. */
const VOID = new Set(['br', 'img', 'hr', 'source', 'input', 'meta', 'link', 'wbr', 'track']);

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function readAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/**
 * Parse markup into a tree. Names are lowercased (the WXR prefixes stay: `wp:post_id`). A closing
 * tag closes the nearest open element of that name and everything opened inside it; a closing
 * tag with no open match is ignored. In `html` mode void elements never take children.
 */
export function parseMarkup(source: string, mode: 'xml' | 'html'): Element {
  const root: Element = { name: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const top = () => stack[stack.length - 1]!;
  const text = (value: string) => {
    if (value) top().children.push(value);
  };
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      text(decodeEntities(source.slice(i)));
      break;
    }
    text(decodeEntities(source.slice(i, lt)));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? source.length : end + 3;
    } else if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      text(source.slice(lt + 9, end < 0 ? source.length : end));
      i = end < 0 ? source.length : end + 3;
    } else if (source[lt + 1] === '?' || source[lt + 1] === '!') {
      const end = source.indexOf('>', lt);
      i = end < 0 ? source.length : end + 1;
    } else {
      const end = source.indexOf('>', lt);
      const m =
        end < 0 ? null : /^<(\/?)([A-Za-z][\w:.-]*)([\s\S]*?)(\/?)$/.exec(source.slice(lt, end));
      if (!m) {
        text('<');
        i = lt + 1;
        continue;
      }
      i = end + 1;
      const name = m[2]!.toLowerCase();
      if (m[1]) {
        const at = stack.map((e) => e.name).lastIndexOf(name);
        if (at > 0) stack.length = at;
        continue;
      }
      const element: Element = { name, attrs: readAttrs(m[3]!), children: [] };
      top().children.push(element);
      if (!m[4] && !(mode === 'html' && VOID.has(name))) stack.push(element);
    }
  }
  return root;
}

export const isElement = (node: Node | undefined): node is Element => typeof node === 'object';

/** Direct child elements, optionally of one name. */
export function childElements(parent: Element, name?: string): Element[] {
  return parent.children.filter(
    (c): c is Element => isElement(c) && (name === undefined || c.name === name)
  );
}

/** The first descendant element of a name, depth first. */
export function find(parent: Element, name: string): Element | undefined {
  for (const child of childElements(parent)) {
    if (child.name === name) return child;
    const deeper = find(child, name);
    if (deeper) return deeper;
  }
  return undefined;
}

/** Every descendant element of a name, depth first. */
export function findAll(parent: Element, name: string): Element[] {
  return childElements(parent).flatMap((child) => [
    ...(child.name === name ? [child] : []),
    ...findAll(child, name),
  ]);
}

/** The text of an element and its descendants, as written. */
export function textOf(node: Node): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('');
}
