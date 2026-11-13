// What the site header and footer render (SiteHeader.svelte, SiteFooter.svelte), built by
// `chromeModel` on the server. Here, not beside it, so a component never imports from server/.

export interface ChromeLink {
  label: string;
  href: string;
}

export interface ChromeModel {
  name: string;
  home: string;
  logo: { src: string; width: number; height: number } | null;
  wordmark: boolean;
  navigation: ChromeLink[];
  legal: ChromeLink[];
  footer: string;
  support: ChromeLink | null;
  help: ChromeLink | null;
}
