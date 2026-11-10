// The chooser's optional search starts after hydration; its named submit buttons remain the
// complete native path. Rejected: rebuilding controls in the document-wide editor script,
// which duplicates the chooser and can race the component's initial DOM.
export function enhanceBlockPickers(): void {
  for (const picker of document.querySelectorAll<HTMLElement>(
    '[data-block-picker]:not([data-picker-ready])'
  )) {
    const form = picker.closest('form');
    const search = picker.querySelector<HTMLElement>('[data-type-search]');
    const input = search?.querySelector<HTMLInputElement>('input');
    const count = search?.querySelector<HTMLElement>('[data-type-count]');
    const choices = [...picker.querySelectorAll<HTMLButtonElement>('button[data-block-type]')];
    if (!(form instanceof HTMLFormElement) || !search || !input) continue;
    picker.setAttribute('data-picker-ready', '');
    input.disabled = false;
    const visible = () => choices.filter((button) => !button.hidden);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLocaleLowerCase();
      for (const button of choices)
        button.hidden = !!q && !(button.textContent ?? '').toLocaleLowerCase().includes(q);
      if (count) {
        count.textContent = visible().length ? '' : (search.dataset.none ?? '');
        count.hidden = !!visible().length;
      }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const first = visible()[0];
      if (first) form.requestSubmit(first);
    });
  }
}
