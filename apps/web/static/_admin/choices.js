// Progressive enhancement for a long Choices list (#133): a search over the labels and a line naming
// what is chosen. The checkboxes in their bounded box stay the whole path without this script, and
// nothing here posts: the search has no name, and a row the search hides still sends its value.
// Rejected: asking the server per keystroke (the whole list is already in the page), and searching
// exactly (an editor who types "muller" should find Müller).
const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const labelOf = (row) => row.querySelector('label')?.textContent.trim() ?? '';

for (const picker of document.querySelectorAll('[data-choice-picker]')) {
  const tools = picker.querySelector('[data-choice-tools]');
  const search = picker.querySelector('[data-choice-search]');
  const list = picker.querySelector('[data-choice-list]');
  const count = picker.querySelector('[data-choice-count]');
  const chosen = picker.querySelector('[data-choice-chosen]');
  const names = picker.querySelector('[data-choice-names]');
  if (!tools || !search || !list || !count || !chosen || !names) continue;
  const rows = () => [...list.querySelectorAll('.ui-choice')];

  const filter = () => {
    const query = fold(search.value.trim());
    const all = rows();
    let shown = 0;
    for (const row of all) {
      row.hidden = Boolean(query) && !fold(labelOf(row)).includes(query);
      if (!row.hidden) shown += 1;
    }
    count.textContent = query
      ? count.dataset.template.replace('{shown}', shown).replace('{total}', all.length)
      : '';
    list.scrollTop = 0;
  };
  const showChosen = () => {
    const picked = rows().filter((row) => row.querySelector('input')?.checked);
    names.textContent = picked.map(labelOf).join(', ');
    chosen.hidden = picked.length === 0;
  };

  // A search changes nothing to save, so a form watching for edits should not hear about it.
  search.addEventListener('input', (event) => {
    event.stopPropagation();
    filter();
  });
  search.addEventListener('change', (event) => event.stopPropagation());
  search.addEventListener('keydown', (event) => {
    // Enter in a text field would save the whole form.
    if (event.key === 'Enter') event.preventDefault();
    if (event.key === 'Escape' && search.value) {
      event.preventDefault();
      search.value = '';
      filter();
    }
  });
  list.addEventListener('change', showChosen);

  tools.hidden = false;
  // A reload can restore what was typed and ticked before it.
  filter();
  showChosen();
}
