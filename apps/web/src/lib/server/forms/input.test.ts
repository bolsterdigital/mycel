// Native predicate decoding is typed and bounded; locale edits preserve unoffered locales.
import { describe, it, expect } from 'vitest';
import { predicate, localizedInput, updateDefinition } from './input.js';
import { FormDefinition } from '@mycel/core';
import { conditionalProbeForm } from '@mycel/core/testing';
const data = (values: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) form.set(k, v);
  return form;
};
describe('native form authoring input', () => {
  it('retains boolean and numeric comparisons, and refuses ambiguous values', () => {
    const values = {
      'when.mode': 'and',
      'when.0.field': 'consent',
      'when.0.op': 'equals',
      'when.0.type': 'boolean',
      'when.0.value': 'true',
      'when.1.field': 'amount',
      'when.1.op': 'not-equals',
      'when.1.type': 'number',
      'when.1.value': '5',
    };
    expect(predicate(data(values), 'when')).toEqual({
      op: 'and',
      conditions: [
        { op: 'equals', fieldId: 'consent', value: true },
        { op: 'not-equals', fieldId: 'amount', value: 5 },
      ],
    });
    expect(() => predicate(data({ ...values, 'when.0.value': 'yes' }), 'when')).toThrow();
    expect(() => predicate(data({ ...values, 'when.mode': 'atom' }), 'when')).toThrow();
  });
  it('preserves all untouched locales and the stable id on a rename', () => {
    expect(
      localizedInput(data({ 'label.nl': 'Nieuw', 'label.en': 'New' }), 'label', { de: 'Alt' })
    ).toEqual({ de: 'Alt', nl: 'Nieuw', en: 'New' });
    const form = conditionalProbeForm('01900000-0000-7000-8000-00000000f000');
    const field = form.fields[0]!;
    const value = updateDefinition(
      data({
        command: 'field',
        fieldId: field.id ?? field.name,
        id: 'forged',
        name: 'new_email',
        type: 'email',
        required: 'on',
        'label.en': 'Address',
      }),
      form
    );
    expect(value.fields[0]?.id).toBe(field.id ?? field.name);
    expect(value.fields[0]?.name).toBe('new_email');
    expect(FormDefinition.safeParse(value).success).toBe(true);
  });
});
