// ColorField on its own: the server render is the whole contract without JavaScript, which is
// how the site form runs. Out of ui.test.ts, which is at its ceiling (scripts/gates/file-size).
import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';
import { render } from 'svelte/server';
import ColorField from './ColorField.svelte';

const html = <P extends Record<string, unknown>>(component: Component<P>, props: P) =>
  render(component as Component<Record<string, unknown>>, { props }).body.replace(
    /<!--[^]*?-->/g,
    ''
  );

describe('ColorField', () => {
  it('is a swatch beside the hex code, and only the code posts', () => {
    const out = html(ColorField, {
      id: 'body-fg',
      name: 'light.body.foreground',
      label: 'Body: text colour',
      locale: 'nl',
      value: '#1A1A1A',
      required: true,
    });
    expect(out).toMatch(
      /<input type="color" id="body-fg-swatch" class="ui-color-swatch" value="#1a1a1a" aria-label="Body: text colour: kleurkiezer"/
    );
    expect(out).not.toMatch(/<input type="color"[^>]*name=/);
    expect(out).toMatch(/<input type="text" name="light.body.foreground"[^>]*id="body-fg"/);
    expect(out).toMatch(/<input type="text"[^>]*value="#1A1A1A"/);
    expect(out).toMatch(/<input type="text"[^>]*pattern="#\[0-9A-Fa-f\]\{6\}"/);
    expect(out).toMatch(/<input type="text"[^>]*required/);
    expect(out).toContain('<label for="body-fg" id="body-fg-label">');
    expect(out).toContain('ui-field size-s');
  });
  it('keeps a hidden label for a table cell, and no colour for a code that is not one', () => {
    const out = html(ColorField, {
      id: 'x',
      name: 'x',
      label: 'X',
      locale: 'en',
      value: '#12',
      hideLabel: true,
    });
    expect(out).toMatch(/^<div class="ui-color hide-label">/);
    expect(out).toContain('<label for="x" id="x-label">X');
    expect(out).toMatch(/type="color" id="x-swatch" class="ui-color-swatch is-empty"/);
    expect(out).toContain('aria-label="X: colour picker, no colour"');
  });
  // An unused optional colour (a card's accent) is empty, not a black that looks chosen.
  it('shows an empty value as no colour and posts it empty, a chosen black as black', () => {
    const empty = html(ColorField, { id: 'e', name: 'e', label: 'E', locale: 'nl', value: '' });
    expect(empty).toMatch(
      /class="ui-color-swatch is-empty"[^>]*aria-label="E: kleurkiezer, geen kleur"/
    );
    expect(empty).toMatch(/<input type="text" name="e"[^>]*value=""/);
    const black = html(ColorField, {
      id: 'b',
      name: 'b',
      label: 'B',
      locale: 'nl',
      value: '#000000',
    });
    expect(black).toMatch(/class="ui-color-swatch" value="#000000" aria-label="B: kleurkiezer"/);
  });
});
