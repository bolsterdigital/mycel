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
  const fields = JSON.parse(form.getAttribute('data-conditions'));
  function update() {
    const values = Object.create(null);
    for (const field of fields) {
      const controls = [...form.querySelectorAll(`[name="${field.name}"]`)];
      const control = controls[0];
      if (!control) continue;
      const active = !field.activeWhen || matches(field.activeWhen, values);
      const required =
        field.baseRequired || !!(field.requiredWhen && matches(field.requiredWhen, values));
      const wrapper = control.closest('[data-form-field]');
      if (wrapper) wrapper.hidden = !active;
      for (const input of controls) {
        input.disabled = !active;
        input.required = active && required;
      }
      const picked = field.presets ? controls.find((input) => input.checked) : control;
      const custom = field.customAmount;
      const own = custom && form.querySelector(`[name="${custom.name}"]`);
      if (own) own.disabled = !active;
      if (!active || !picked?.validity.valid) continue;
      const raw = (
        custom && picked.value === custom.choice
          ? (own?.value ?? '').replace(',', '.')
          : picked.value
      ).trim();
      if (raw && field.pattern && !new RegExp(field.pattern).test(raw)) continue;
      if (
        field.type === 'amount' &&
        raw &&
        (Number(raw) < (field.min ?? 0) ||
          Number(raw) < 0 ||
          (field.max !== undefined && Number(raw) > field.max) ||
          Math.abs(Number(raw) * 100 - Math.round(Number(raw) * 100)) > 1e-7)
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
