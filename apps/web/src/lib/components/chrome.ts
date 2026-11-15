// What the site header and footer render (SiteHeader.svelte, SiteFooter.svelte), built by
// `chromeModel` on the server. Here, not beside it, so a component never imports from server/.

export interface ChromeLink {
  label: string;
  href: string;
}

/**
 * A node of a placed menu (ADR 036 rule 2): a link with an optional row of sublinks, or a group,
 * which has a label and sublinks but no destination of its own. Two levels, never more.
 */
export type ChromeNode =
  | (ChromeLink & { kind: 'link'; children: ChromeLink[] })
  | { kind: 'group'; label: string; children: ChromeLink[] };

/** A footer column (ADR 036 rule 4): a placed menu with an optional title. */
export interface ChromeColumn {
  title: string | null;
  nodes: ChromeNode[];
}

export interface ChromeModel {
  name: string;
  home: string;
  logo: { src: string; width: number; height: number } | null;
  wordmark: boolean;
  /** The whole main menu, which the panel shows (ADR 036 rule 4). */
  main: ChromeNode[];
  /** The top-level nodes the editor placed in the bar, in menu order; how many show is measured. */
  bar: ChromeNode[];
  /** At most two calls to action, the first primary. */
  actions: ChromeLink[];
  footer: string;
  columns: ChromeColumn[];
  legal: ChromeNode[];
}

// A trailing slash does not make another page: the home link is `/` or `/probe/`, its address
// `/probe`.
const bare = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** Whether `href` is the page at `path`: the same path, an anchor on it included. */
export const isCurrent = (href: string, path: string | null): boolean =>
  path !== null && bare(href.split('#')[0]!) === bare(path);

/** Whether the node or one of its sublinks is the page at `path`, so its branch opens. */
export const holdsCurrent = (node: ChromeNode, path: string | null): boolean =>
  (node.kind === 'link' && isCurrent(node.href, path)) ||
  node.children.some((c) => isCurrent(c.href, path));
