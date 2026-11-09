// What the hero's description line says (#158). Derived only from the fields ADR 025 already has:
// an absent `heroAlt` is decorative, a present one is required in every published locale, so
// "missing here" exists only while another locale has text. Nothing here is stored. The screen's
// script (`static/_admin/edit-screen.js`) repeats this order for the live update; it cannot import
// a TypeScript module, and e2e covers that both say the same. Rejected: a stored "reviewed" flag,
// a third state ADR 025 excludes, and a warning on decorative that could never be dismissed.
export type HeroAltState = 'described' | 'missing' | 'decorative' | 'fresh' | 'cleared';
export type HeroAltTone = 'ok' | 'neutral' | 'warn' | 'info' | 'err';

export type HeroAltInput = {
  /** The text of the locale on screen. */
  text: string;
  /** The other locales of the item, with their stored text. */
  others: Readonly<Record<string, string | undefined>>;
  /** The chosen image is not the stored one: stored descriptions no longer apply (MY-110 B3). */
  replaced: boolean;
  /** The "remove in every language" box is ticked. */
  clearing: boolean;
  /** A refused save or publish named this field. */
  flagged: boolean;
};

export type HeroAltView = {
  state: HeroAltState;
  tone: HeroAltTone;
  /** The other locales without a description (after a save, for a replaced image). */
  lacking: string[];
  /** The other locales whose description still applies. */
  described: string[];
};

export function heroAltView(input: HeroAltInput): HeroAltView {
  const others = Object.keys(input.others);
  const described = input.replaced ? [] : others.filter((l) => input.others[l]?.trim());
  const lacking = others.filter((l) => !described.includes(l));
  const view = (state: HeroAltState, tone: HeroAltTone) => ({ state, tone, lacking, described });
  if (input.clearing) return view('cleared', 'neutral');
  if (input.text.trim()) return view('described', input.flagged ? 'err' : 'ok');
  if (input.flagged) return view('missing', 'err');
  if (input.replaced) return view('fresh', 'info');
  return described.length ? view('missing', 'warn') : view('decorative', 'neutral');
}

/** An editor's merged description map as the explicit existing image-use pair. */
export function imageAltProps(alt: unknown): { decorative: boolean; alt: unknown } {
  return { decorative: alt === null, alt };
}
