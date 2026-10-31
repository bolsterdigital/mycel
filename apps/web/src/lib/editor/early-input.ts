// Hydration must not replace native input typed while the enhancement bundle was loading.
// Capture changed controls before Svelte claims the form; untouched server values stay data.
export function earlyInput(id: string): Record<string, string | string[]> {
  if (typeof document === 'undefined') return {};
  const form = document.getElementById(id);
  if (!(form instanceof HTMLFormElement)) return {};
  const changed = new Set<string>();
  for (const control of Array.from(form.elements)) {
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      if (
        control.value !== control.defaultValue ||
        (control instanceof HTMLInputElement && control.checked !== control.defaultChecked)
      )
        changed.add(control.name);
    } else if (control instanceof HTMLSelectElement) {
      const options = Array.from(control.options);
      // A single select with no selected attribute starts at its first option automatically.
      const initial = options.filter((option) => option.defaultSelected).at(-1) ?? options[0];
      const changedSelection = control.multiple
        ? options.some((option) => option.selected !== option.defaultSelected)
        : control.value !== initial?.value;
      if (changedSelection) changed.add(control.name);
    }
  }
  const data = new FormData(form);
  const values = Object.fromEntries(
    Array.from(changed)
      .filter(Boolean)
      .map((name) => {
        const values = data.getAll(name).filter((v): v is string => typeof v === 'string');
        return [name, name === 'locales' || name === 'authorIds' ? values : (values[0] ?? '')];
      })
  );
  return {
    ...values,
    $openBlocks: Array.from(form.querySelectorAll('details.block[open]')).map((block) =>
      block.id.replace('block-', '')
    ),
  };
}
