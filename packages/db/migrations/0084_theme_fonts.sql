-- MY-261 (brief site-fonts): a theme names a heading font and a body font from the catalogue
-- (`core/theme/fonts.ts`) instead of one of two font pairs, so the stored key `fontPair` goes. A
-- site that had it falls back to the default, Inter for both, until someone chooses again: clean
-- cut while there are no production sites (decision 2026-11-15). Rejected: translating the pair
-- into the two new keys, which is the backwards compatibility that decision rules out, and a
-- reader that ignores the old key, which would keep a dead field alive in every stored theme.
update site_settings set theme = theme - 'fontPair' where theme -> 'fontPair' is not null;
