// Progressive enhancement for the shared MediaPicker (brief media-picker, TODO #66): search the
// site's images, upload by dropping or choosing files with progress per file, and show the
// chosen thumbnail at once. The server-rendered radio grid stays the whole path without this
// script. Everything is delegated from `document`, so pickers a hydrated page adds later (the
// article writer's image cards) work too; the tools are built the first time a dialog opens.
// Uploads use XMLHttpRequest because fetch has no upload progress. Rejected: a client bundle for
// the admin, which ships none (ADR 009).
const DEBOUNCE_MS = 250;
const enhanced = new WeakSet();

const copyOf = (picker) => JSON.parse(picker.dataset.copy || '{}');
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === false) continue;
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children);
  return node;
}

/** One choice, the same markup as the component's `option` snippet. */
function option(picker, choice, checked = false) {
  const thumb = choice.thumb
    ? `${picker.dataset.choices.replace(/choices$/, '')}${choice.id}/thumb`
    : '';
  const input = el('input', {
    type: 'radio',
    name: picker.dataset.name,
    value: choice.id,
    'data-label': choice.label,
    'data-thumb': thumb,
  });
  input.checked = checked;
  const visual = thumb
    ? el('img', { src: thumb, alt: '', width: '160', height: '120', loading: 'lazy' })
    : el('span', { class: 'ui-media-option-blank' });
  return el('li', {}, [
    el('label', { class: 'ui-media-option' }, [
      input,
      visual,
      el('span', { class: 'ui-media-option-name', text: choice.label }),
    ]),
  ]);
}

function showChoice(picker, input) {
  const copy = copyOf(picker);
  const img = picker.querySelector('[data-picker-img]');
  const name = picker.querySelector('[data-picker-name]');
  const trigger = picker.querySelector('button[command="show-modal"]');
  if (img) {
    img.hidden = !input.dataset.thumb;
    if (input.dataset.thumb) img.src = input.dataset.thumb;
    else img.removeAttribute('src');
  }
  if (name) {
    name.textContent = input.value ? input.dataset.label || input.value : copy.none;
    name.classList.toggle('muted', !input.value);
  }
  if (trigger) trigger.textContent = input.value ? copy.change : copy.choose;
}

document.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'radio' || !input.checked) return;
  const picker = input.closest('[data-media-picker]');
  if (picker && input.name === picker.dataset.name) showChoice(picker, input);
});

// `toggle` does not bubble; a capturing listener still sees it on every dialog.
document.addEventListener(
  'toggle',
  (event) => {
    const dialog = event.target;
    if (!(dialog instanceof HTMLDialogElement) || event.newState !== 'open') return;
    const picker = dialog.closest('[data-media-picker]');
    if (picker && !enhanced.has(picker)) {
      enhanced.add(picker);
      enhance(picker);
    }
  },
  true
);

/** The checked radio of this picker, wherever it is in the dialog. */
const checked = (picker) =>
  [...picker.querySelectorAll('input[type="radio"]')].find(
    (i) => i.name === picker.dataset.name && i.checked
  );

function enhance(picker) {
  const copy = copyOf(picker);
  const tools = picker.querySelector('[data-picker-tools]');
  const initial = picker.querySelector('[data-picker-initial]');
  const results = picker.querySelector('[data-picker-results]');
  const id = picker.querySelector('dialog')?.id ?? 'picker';
  if (!tools || !initial || !results) return;
  picker.querySelector('[data-picker-noscript]')?.remove();

  const search = el('input', { type: 'search', id: `${id}-search`, autocomplete: 'off' });
  const status = el('p', { class: 'ui-hint', role: 'status' });
  const more = el('button', { type: 'button', class: 'ui-button secondary', text: copy.more });
  const moreHost = el('div', { class: 'ui-media-picker-more', hidden: true }, [more]);
  tools.append(
    el('div', { class: 'ui-field' }, [el('label', { for: search.id, text: copy.search }), search])
  );

  let cursor = null;
  let query = '';
  let timer;
  let controller;

  /** Keep the chosen radio when the results are replaced: it moves to the top of the grid. */
  function keepChosen() {
    const input = checked(picker);
    if (input && results.contains(input)) initial.prepend(input.closest('li'));
  }

  async function load(append) {
    controller?.abort();
    controller = new AbortController();
    const url = new URL(picker.dataset.choices, location.href);
    url.searchParams.set('q', query);
    if (append && cursor) url.searchParams.set('cursor', cursor);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      if (!append) {
        keepChosen();
        results.replaceChildren();
      }
      const current = checked(picker)?.value;
      for (const choice of body.items)
        results.append(option(picker, choice, choice.id === current));
      cursor = body.nextCursor;
      moreHost.hidden = !cursor;
      status.textContent = results.children.length === 0 ? copy.nothing : '';
    } catch (error) {
      if (error.name === 'AbortError') return;
      status.textContent = copy.searchFailed;
      results.hidden = true;
      initial.hidden = false;
    }
  }

  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query = search.value.trim();
      const searching = query !== '';
      results.hidden = !searching;
      initial.hidden = searching;
      if (!searching) {
        keepChosen();
        results.replaceChildren();
        moreHost.hidden = true;
        status.textContent = '';
        return;
      }
      load(false);
    }, DEBOUNCE_MS);
  });
  more.addEventListener('click', () => load(true));
  results.after(moreHost);
  tools.append(status);

  if (picker.dataset.upload)
    tools.prepend(
      uploader(picker, copy, id, initial, () => {
        // An upload lands in the full grid; leave a search so it can be seen.
        if (search.value) {
          search.value = '';
          query = '';
          keepChosen();
          results.replaceChildren();
          results.hidden = true;
          moreHost.hidden = true;
          initial.hidden = false;
          status.textContent = '';
        }
      })
    );
}

function uploader(picker, copy, id, initial, reveal) {
  const input = el('input', {
    type: 'file',
    id: `${id}-upload`,
    class: 'ui-filedrop',
    accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif',
    multiple: true,
  });
  const progress = el('ul', { class: 'ui-media-uploads', 'aria-live': 'polite' });
  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    reveal();
    let last = null;
    for (const file of files) {
      const bar = el('progress', { max: '100', value: '0' });
      const line = el('span', { text: fill(copy.uploading, { filename: file.name }) });
      const item = el('li', {}, [line, bar]);
      progress.append(item);
      const outcome = await send(picker.dataset.upload, file, (p) => (bar.value = p));
      bar.remove();
      if (outcome.choice) {
        line.textContent = fill(copy.uploaded, { filename: outcome.choice.label });
        const li = option(picker, outcome.choice);
        // After "No image", before the older images.
        initial.firstElementChild ? initial.firstElementChild.after(li) : initial.append(li);
        last = li.querySelector('input');
      } else {
        item.classList.add('ui-error');
        line.textContent = `${file.name}: ${outcome.error || copy.failed}`;
      }
    }
    if (last) {
      last.checked = true;
      last.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  return el('div', { class: 'ui-field' }, [
    el('label', { for: input.id, text: copy.drop }),
    input,
    progress,
  ]);
}

/** POST one file; resolves with `{ choice }` or `{ error }`, never rejects. */
function send(url, file, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // A login page after an expired session, or a proxy error: no JSON.
      }
      if (xhr.status === 201 && body?.id) resolve({ choice: body });
      else resolve({ error: body?.error ?? '' });
    });
    xhr.addEventListener('error', () => resolve({ error: '' }));
    const data = new FormData();
    data.append('file', file);
    xhr.send(data);
  });
}
