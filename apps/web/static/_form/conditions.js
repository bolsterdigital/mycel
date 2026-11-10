// Display enhancement for the server's versioned predicates. No script grants consent or sends
// an action: form.submit revalidates everything. Without this file every native field is shown.
export function matches(predicate, values) {
  if ('conditions' in predicate)
    return predicate.op === 'and'
      ? predicate.conditions.every((p) => matches(p, values))
      : predicate.conditions.some((p) => matches(p, values));
  if (!Object.hasOwn(values, predicate.fieldId)) return false;
  const value = values[predicate.fieldId];
  if (value === undefined) return false;
  if (predicate.op === 'present')
    return value !== '' && value !== false && (!Array.isArray(value) || value.length > 0);
  const equal = Array.isArray(value)
    ? value.includes(String(predicate.value))
    : value === predicate.value;
  return predicate.op === 'equals' ? equal : !equal;
}
export function enhance(form) {
  const fields = JSON.parse(form.dataset.conditions);
  function update() {
    const values = Object.create(null);
    for (const field of fields) {
      const control = form.elements.namedItem(field.name);
      if (!control) continue;
      const active = !field.activeWhen || matches(field.activeWhen, values);
      const required =
        field.baseRequired || !!(field.requiredWhen && matches(field.requiredWhen, values));
      const wrapper = control.closest('[data-form-field]');
      if (wrapper) wrapper.hidden = !active;
      control.disabled = !active;
      if ('required' in control) control.required = active && required;
      if (!active || !control.validity.valid) continue;
      const raw = control.value.trim();
      if (raw && field.pattern && !new RegExp(field.pattern).test(raw)) continue;
      if (
        field.type === 'amount' &&
        raw &&
        (Number(raw) < 0 || Math.abs(Number(raw) * 100 - Math.round(Number(raw) * 100)) > 1e-7)
      )
        continue;
      let value;
      if (field.type === 'checkbox' || field.type === 'consent') value = control.checked;
      else if (field.type === 'multiple-choice')
        value = [...control.selectedOptions].map((o) => o.value);
      else if (raw) value = field.type === 'number' || field.type === 'amount' ? Number(raw) : raw;
      if (value !== undefined)
        values[field.id] = field.type === 'email' ? String(value).toLowerCase() : value;
    }
  }
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
}
if (typeof document !== 'undefined')
  for (const form of document.querySelectorAll('form[data-conditions]')) enhance(form);
