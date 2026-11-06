// Progressive enhancement for a button's target (TargetPicker): one search field that
// finds pages and articles together, or takes an address that starts with `/` or `http(s)://`.
// It writes its choice into the select and address field the server rendered, which stay in the
// form and are the whole path without this script; the search itself has no name. The select's
// options (the newest hundred) answer at once; the route behind `data-choices` adds older ones.
// A combobox in the ARIA 1.2 pattern: the list opens while typing, the arrows move through it,
// Enter or a click chooses, Escape closes and then restores. Leaving the field with words that
// match nothing restores the choice it had. Pickers a later render adds are enhanced by the
// observer. Rejected: a client bundle for the admin, which ships none (ADR 009), and searching
// exactly (an editor who types "muller" should find Müller).
const DEBOUNCE_MS = 200;
const SHOWN = 8;
const ADDRESS = /^(\/|https?:\/\/)/i;
const enhanced = new WeakSet();

const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');

function enhance(picker) {
  if (enhanced.has(picker)) return;
  const search = picker.querySelector('[data-target-search]');
  const native = picker.querySelector('[data-target-native]');
  const select = native?.querySelector('select');
  const address = native?.querySelector('input');
  const input = search?.querySelector('input[role="combobox"]');
  const list = search?.querySelector('[role="listbox"]');
  const status = search?.querySelector('[data-target-status]');
  if (!search || !native || !select || !address || !input || !list || !status) return;
  enhanced.add(picker);
  const copy = JSON.parse(picker.dataset.copy || '{}');

  /** The items the select holds, without "(none)" and "the address below". */
  const local = () =>
    [...select.options]
      .filter((o) => o.value && o.value !== 'url')
      .map((o) => ({ id: o.value, label: o.textContent.trim() }));
  /** What the field shows for the stored choice. */
  const current = () =>
    select.value === 'url' || (!select.value && address.value)
      ? address.value
      : select.value
        ? (select.selectedOptions[0]?.textContent.trim() ?? '')
        : '';

  let options = [];
  let active = -1;
  let timer;
  let controller;

  const open = (yes) => {
    list.hidden = !yes;
    input.setAttribute('aria-expanded', String(yes));
    if (!yes) {
      active = -1;
      input.removeAttribute('aria-activedescendant');
    }
  };

  function render() {
    list.replaceChildren(
      ...options.map((option, i) => {
        const li = document.createElement('li');
        li.id = `${list.id}-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.textContent = option.address
          ? fill(copy.address, { address: option.address })
          : option.label;
        // Keep the focus in the field, so the click lands as a choice and not as a blur.
        li.addEventListener('mousedown', (event) => event.preventDefault());
        li.addEventListener('click', () => choose(option));
        return li;
      })
    );
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
    open(options.length > 0);
    status.textContent = input.value.trim()
      ? options.length
        ? fill(copy.found, { n: options.filter((o) => !o.address).length })
        : copy.nothing
      : '';
  }

  function matches(query, extra = []) {
    const q = fold(query);
    const seen = new Set();
    const found = [];
    for (const item of [...local(), ...extra]) {
      if (seen.has(item.id) || !fold(item.label).includes(q)) continue;
      seen.add(item.id);
      found.push(item);
      if (found.length === SHOWN) break;
    }
    return ADDRESS.test(query) ? [{ address: query }, ...found] : found;
  }

  async function ask(query) {
    controller?.abort();
    controller = new AbortController();
    const url = new URL(picker.dataset.choices, location.href);
    url.searchParams.set('q', query);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      if (input.value.trim() !== query) return;
      options = matches(query, body.items);
      render();
    } catch (error) {
      if (error.name !== 'AbortError' && !options.length) status.textContent = copy.failed;
    }
  }

  /** Write a choice into the controls that post, and say so to the form's change watchers. */
  function choose(option) {
    if (option === null) {
      select.value = '';
      address.value = '';
    } else if (option.address) {
      select.value = 'url';
      address.value = option.address;
    } else {
      if (![...select.options].some((o) => o.value === option.id))
        select.append(new Option(option.label, option.id));
      select.value = option.id;
      address.value = '';
    }
    for (const control of [select, address])
      control.dispatchEvent(new Event('change', { bubbles: true }));
    input.value = current();
    options = [];
    status.textContent = '';
    open(false);
  }

  /** Leaving the field: an address or an empty field is a choice, a single match too. */
  function settle() {
    const typed = input.value.trim();
    if (typed === current()) return open(false);
    if (!typed) return choose(null);
    if (ADDRESS.test(typed)) return choose({ address: typed });
    const items = matches(typed).filter((o) => !o.address);
    if (items.length === 1) return choose(items[0]);
    input.value = current();
    status.textContent = '';
    open(false);
  }

  input.addEventListener('input', (event) => {
    // Typing changes nothing to save until a choice is written into the controls.
    event.stopPropagation();
    const query = input.value.trim();
    active = -1;
    options = query ? matches(query) : [];
    render();
    clearTimeout(timer);
    if (query && !ADDRESS.test(query)) timer = setTimeout(() => ask(query), DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) options = matches(input.value.trim());
      if (!options.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + options.length) % options.length;
      render();
    } else if (event.key === 'Enter' && !list.hidden) {
      // Enter in the open list chooses; it never submits the form under it.
      event.preventDefault();
      choose(options[Math.max(active, 0)]);
    } else if (event.key === 'Enter') {
      settle();
    } else if (event.key === 'Escape') {
      if (!list.hidden) {
        event.preventDefault();
        open(false);
      } else input.value = current();
    }
  });
  input.addEventListener('blur', settle);

  input.value = current();
  native.hidden = true;
  search.hidden = false;
}

const all = () => document.querySelectorAll('[data-target-picker]').forEach(enhance);
all();
// Only an added element can hold a new picker; typing in the writer adds text, not elements.
new MutationObserver((records) => {
  if (records.some((r) => [...r.addedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE))) all();
}).observe(document.body, { childList: true, subtree: true });
