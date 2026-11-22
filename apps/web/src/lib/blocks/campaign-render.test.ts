import { describe, expect, it } from 'vitest';
import { compactForm } from './campaign-render.js';
import type { RenderForm } from './model.js';

const field = (type: string) => ({ name: type, type, label: type, required: false }) as never;
const form = (types: string[], extra: Partial<RenderForm> = {}) =>
  ({ formId: 'f', fields: types.map(field), ...extra }) as unknown as RenderForm;

describe('compactForm (MY-267 PR 5, ADR 038 rule 9)', () => {
  it('marks a form of up to four visible fields, hidden fields not counted', () => {
    expect(compactForm(form(['email', 'consent']))).toBe(true);
    expect(compactForm(form(['text', 'text', 'email', 'consent', 'hidden', 'hidden']))).toBe(true);
  });

  it('leaves a longer form, a membership form and no form to scroll with the page', () => {
    expect(compactForm(form(['text', 'text', 'email', 'text', 'consent']))).toBe(false);
    expect(compactForm(form(['email'], { membership: { legend: 'x', options: [] } }))).toBe(false);
    expect(compactForm(null)).toBe(false);
  });
});
