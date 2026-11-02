// Library-wide file drops reuse the authenticated media upload endpoint and server-rendered
// grid. Native upload forms remain the keyboard/no-script path. XHR provides real upload
// progress; no originals or guessed client-side cards are used to rebuild the library.
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const host = () => document.querySelector('[data-upload-dropzone]');
const isFileDrag = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
let depth = 0;
let queue = Promise.resolve();
let pending = 0;
let suppressed = false;

function overlay(show) {
  const zone = host();
  const panel = zone?.querySelector('[data-upload-overlay]');
  if (!panel) return;
  const wasHidden = panel.hidden;
  panel.hidden = !show;
  if (show && wasHidden)
    zone.querySelector('[data-upload-announcement]').textContent =
      panel.querySelector('strong').textContent;
  if (!show) zone.querySelector('[data-upload-announcement]').textContent = '';
}

// An open upload dialog owns its access choice. Keep drops on its native input native,
// and suppress file navigation elsewhere rather than silently uploading as public.
function nativeDialog(event) {
  if (!document.querySelector('dialog[open]')) return false;
  if (!(event.target instanceof HTMLInputElement && event.target.type === 'file'))
    event.preventDefault();
  depth = 0;
  overlay(false);
  return true;
}

// Count nested enters/leaves so moving across cards does not flicker the overlay.
document.addEventListener('dragenter', (event) => {
  if (!host() || !isFileDrag(event) || nativeDialog(event)) return;
  event.preventDefault();
  depth++;
  if (!suppressed) overlay(true);
});
document.addEventListener('dragover', (event) => {
  if (!host() || !isFileDrag(event) || nativeDialog(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (event) => {
  if (!host() || !isFileDrag(event)) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) {
    suppressed = false;
    overlay(false);
  }
});
window.addEventListener('blur', () => {
  depth = 0;
  suppressed = false;
  overlay(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    suppressed = true;
    overlay(false);
  }
});
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-upload-dismiss]') && pending === 0) {
    const results = host()?.querySelector('[data-upload-results]');
    if (results) {
      results.hidden = true;
      results.querySelector('ul').replaceChildren();
    }
  }
});
document.addEventListener('drop', (event) => {
  const zone = host();
  if (!zone || !isFileDrag(event) || nativeDialog(event)) return;
  event.preventDefault(); // Never navigate the browser to a dropped file, including on failure.
  depth = 0;
  suppressed = false;
  overlay(false);
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  pending++;
  zone.querySelector('[data-upload-dismiss]').disabled = true;
  queue = queue
    .then(() => upload(zone, files))
    .finally(() => {
      pending--;
      if (pending === 0) zone.querySelector('[data-upload-dismiss]').disabled = false;
    });
});

async function upload(zone, files) {
  const copy = JSON.parse(zone.dataset.copy);
  const list = zone.querySelector('[data-upload-progress]');
  zone.querySelector('[data-upload-results]').hidden = false;
  let added = false;
  for (const file of files) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = fill(copy.uploading, { filename: file.name });
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = 0;
    bar.setAttribute('aria-label', label.textContent);
    row.append(label, bar);
    list.append(row);
    const result = await send(zone.dataset.url, file, (value) => (bar.value = value));
    bar.remove();
    if (result.choice) {
      added = true;
      label.textContent = fill(copy.uploaded, { filename: file.name });
      const link = document.createElement('a');
      link.href = `${zone.dataset.url.replace(/\/upload$/, '')}/${result.choice.id}`;
      link.textContent = fill(copy.open, { filename: file.name });
      row.append(link);
    } else {
      row.classList.add('ui-error');
      label.textContent = `${file.name}: ${result.error || copy.failed}`;
    }
  }
  if (!added || !zone.isConnected) return;
  // Clear search/cursor so new files are visible. Keep the chosen grid/list view and locale.
  const url = new URL(location.href);
  for (const key of ['q', 'cursor', 'done']) url.searchParams.delete(key);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('refresh');
    // DOMParser HTML sinks require TrustedHTML under our CSP. Parse with the platform's
    // sanitizing API, preserving layout attributes. Browsers without Trusted Types can parse
    // this same-origin server-rendered page inertly; no new permissive policy is installed.
    const html = await response.text();
    const doc =
      typeof Document.parseHTML === 'function'
        ? Document.parseHTML(html, { sanitizer: { removeElements: ['script'] } })
        : !window.trustedTypes
          ? new DOMParser().parseFromString(html, 'text/html')
          : null;
    if (!doc) throw new Error('refresh');
    const library = doc.querySelector('.ui-overview-list');
    if (!library) throw new Error('refresh');
    document.querySelector('.ui-overview-list').replaceWith(library);
    const storage = doc.querySelector('[data-media-storage]');
    if (storage) document.querySelector('[data-media-storage]')?.replaceWith(storage);
    history.replaceState(null, '', url);
  } catch {
    const row = document.createElement('li');
    row.className = 'ui-error';
    row.textContent = copy.refresh;
    list.append(row);
  }
}

function send(url, file, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = 120000;
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('load', () => {
      let body;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* Expired session or proxy error. */
      }
      resolve(xhr.status === 201 && body?.id ? { choice: body } : { error: body?.error });
    });
    for (const event of ['error', 'timeout', 'abort'])
      xhr.addEventListener(event, () => resolve({ error: '' }));
    const data = new FormData();
    data.append('file', file);
    xhr.send(data);
  });
}
