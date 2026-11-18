// The block grammar of `post_content`: `<!-- wp:name {"json":"attrs"} -->…<!-- /wp:name -->` or
// the self-closing `<!-- wp:name /-->`, nested for inner blocks, with HTML outside any block as a
// freeform chunk. Our own reader of the published grammar, because the reference implementation
// (`@wordpress/block-serialization-default-parser`) is GPL-2.0-or-later, which the licence gate
// does not accept (ADR 006). The delimiter pattern is the one that parser uses: attributes are a
// JSON object, and WordPress escapes `--` inside them, so the lazy match cannot end early.

export interface WpBlock {
  /** `core/paragraph`; the implicit `core/` namespace is written out. Null for freeform HTML. */
  name: string | null;
  attrs: Record<string, unknown>;
  innerBlocks: WpBlock[];
  /** The block's own HTML and that of its inner blocks, with every block comment removed. */
  html: string;
}

const DELIMITER =
  /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+(?:(\{[\s\S]*?\})\s+)?(\/)?-->/g;

interface Open {
  block: WpBlock;
  /** Where the block's content starts in the source. */
  start: number;
}

const stripComments = (html: string) => html.replace(DELIMITER, '');

/** Parse post content into top-level blocks; whitespace-only freeform chunks are dropped. */
export function parseBlocks(content: string): WpBlock[] {
  const top: WpBlock[] = [];
  const stack: Open[] = [];
  let last = 0;
  const freeform = (html: string) => {
    if (html.trim() && stack.length === 0)
      top.push({ name: null, attrs: {}, innerBlocks: [], html });
  };
  const add = (block: WpBlock) => {
    const parent = stack[stack.length - 1];
    (parent ? parent.block.innerBlocks : top).push(block);
  };
  for (const m of content.matchAll(DELIMITER)) {
    const [whole, closer, namespace, local, json, selfClosing] = m;
    const name = `${namespace ?? 'core/'}${local}`;
    freeform(content.slice(last, m.index));
    last = m.index + whole.length;
    if (closer) {
      const at = stack.map((o) => o.block.name).lastIndexOf(name);
      if (at < 0) continue;
      const open = stack[at]!;
      stack.length = at;
      open.block.html = stripComments(content.slice(open.start, m.index));
      add(open.block);
      continue;
    }
    let attrs: Record<string, unknown> = {};
    try {
      const parsed: unknown = json ? JSON.parse(json) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        attrs = parsed as Record<string, unknown>;
    } catch {
      // Attributes that are not JSON are none; the mapping reports what it then misses.
    }
    const block: WpBlock = { name, attrs, innerBlocks: [], html: '' };
    if (selfClosing) add(block);
    else stack.push({ block, start: last });
  }
  // Trailing HTML is freeform only outside every block (`freeform` checks the stack); an opener
  // without its closer takes the rest of the content, as WordPress does.
  freeform(content.slice(last));
  while (stack.length) {
    const open = stack.pop()!;
    open.block.html = stripComments(content.slice(open.start));
    add(open.block);
  }
  return top;
}
