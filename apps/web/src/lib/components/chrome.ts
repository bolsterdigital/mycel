// What the site header and footer render (SiteHeader.svelte, SiteFooter.svelte), built by
// `chromeModel` on the server. Here, not beside it, so a component never imports from server/.

export interface ChromeLink {
  label: string;
  href: string;
}

/** A footer column (ADR 036 rule 4): a placed menu with an optional title. */
export interface ChromeColumn {
  title: string | null;
  links: ChromeLink[];
}

export interface ChromeModel {
  name: string;
  home: string;
  logo: { src: string; width: number; height: number } | null;
  wordmark: boolean;
  /** The bar of the main navigation; the full panel with groups and sublinks is step D. */
  navigation: ChromeLink[];
  /** At most two calls to action, the first primary. */
  actions: ChromeLink[];
  footer: string;
  columns: ChromeColumn[];
  legal: ChromeLink[];
}
