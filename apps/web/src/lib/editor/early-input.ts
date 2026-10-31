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
    } else if (
      control instanceof HTMLSelectElement &&
      Array.from(control.options).some((o) => o.selected !== o.defaultSelected)
    )
      changed.add(control.name);
  }
  const data = new FormData(form);
  return Object.fromEntries(
    Array.from(changed)
      .filter(Boolean)
      .map((name) => {
        const values = data.getAll(name).filter((v): v is string => typeof v === 'string');
        const control = form.elements.namedItem(name);
        return [
          name,
          control instanceof RadioNodeList || name === 'locales' || name === 'authorIds'
            ? values
            : (values[0] ?? ''),
        ];
      })
  );
}
