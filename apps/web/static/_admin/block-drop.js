// Image files dropped or pasted on the edit screen become a block at that place (brief
// drag-and-drop-upload). Each file goes through `media/upload` with its own progress in the panel
// of `BlockDrop.svelte`; then the screen's `insert` action gets the block and the uploaded ids, so
// what was typed is saved first and a conflict comes back as from any other action. One image
// becomes an image block, several one gallery: the screen holds one unsaved block at a time, and
// that block comes back with its alt text in focus (edit-screen.js). It inserts only when every
// file arrived as an image; otherwise the panel keeps each result and offers to place what did.
//
// The place follows the pointer: before the first block whose middle lies below it, else at the
// end; outside the blocks it is the end, and the panel says which. A paste goes after the block
// that has the focus. An article's writer places images itself, between its paragraphs
// (WritingSurface.svelte): a drop or paste inside it is its own, one elsewhere on the screen goes
// to its end. An open dialog (the media picker) keeps its own file field.
// Rejected: inserting a block per file on the server without its alt text (core refuses an image
// without one), and a full-window overlay as on the media page, which hides where it lands.
import { isImage, send } from './upload-file.js';

const form = document.getElementById('item-edit');
const host = document.querySelector('[data-block-drop]');

if (form instanceof HTMLFormElement && host instanceof HTMLElement) {
  const copy = JSON.parse(host.dataset.copy ?? '{}');
  const most = Number(host.dataset.maxImages) || 24;
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
  const part = (name) => host.querySelector(`[data-block-drop-${name}]`);
  const isFileDrag = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  /** The article writer, once it took over the blocks; null on a page or without its script. */
  const writer = () => {
    const surface = form.querySelector('[data-article-writer]');
    return surface?.querySelector('.ProseMirror') ? surface : null;
  };
  const inWriter = (target) => target instanceof Node && !!writer()?.contains(target);
  /** The stored blocks in their order, by the card that stands for each. */
  const cards = () =>
    [...form.querySelectorAll('.item-blocks [data-block-card]')].filter(
      (card) => card.getClientRects().length > 0
    );
  const idOf = (card) => card.dataset.blockCard.replace(/^block-/, '');

  /** Where a drop at `y` over `target` puts the block: `before:<id>` or `end`, and its marker. */
  const placeAt = (y, target) => {
    const list = cards();
    const inBlocks = target instanceof Element && !!target.closest('.item-blocks');
    if (!inBlocks || writer()) return { place: 'end', card: list.at(-1), side: 'after', end: true };
    const below = list.find((card) => {
      const box = card.getBoundingClientRect();
      return box.top + box.height / 2 > y;
    });
    return below
      ? { place: `before:${idOf(below)}`, card: below, side: 'before', end: false }
      : { place: 'end', card: list.at(-1), side: 'after', end: true };
  };
  let marked = null;
  const mark = (spot) => {
    if (marked && marked !== spot?.card) delete marked.dataset.dropAt;
    marked = spot?.card ?? null;
    if (marked) marked.dataset.dropAt = spot.side;
  };

  let depth = 0;
  let suppressed = false;
  let uploading = false;
  const prompt = (spot) => {
    const shown = !!spot && !suppressed;
    const panel = part('prompt');
    if (shown) {
      const words = inWriter(spot.target) || !spot.end ? copy.here : copy.end;
      if (part('where').textContent !== words) {
        part('where').textContent = words;
        part('announcement').textContent = words;
      }
    }
    panel.hidden = !shown;
    host.hidden = panel.hidden && part('results').hidden;
    mark(shown && !inWriter(spot.target) && !writer() ? spot : null);
  };
  const reset = () => {
    depth = 0;
    suppressed = false;
    prompt(null);
    part('announcement').textContent = '';
  };
  const ours = (event) => isFileDrag(event) && !document.querySelector('dialog[open]');

  document.addEventListener('dragenter', (event) => {
    if (!ours(event)) return;
    event.preventDefault();
    depth++;
  });
  document.addEventListener('dragover', (event) => {
    if (!ours(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    prompt({ ...placeAt(event.clientY, event.target), target: event.target });
  });
  document.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) reset();
  });
  window.addEventListener('blur', reset);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || part('prompt').hidden) return;
    suppressed = true;
    prompt(null);
  });
  document.addEventListener('drop', (event) => {
    if (!ours(event)) return;
    // The writer handled a drop on its own text; it never navigates to the file either.
    const target = event.target;
    const spot = placeAt(event.clientY, target);
    const skipped = suppressed;
    reset();
    if (inWriter(target)) return;
    event.preventDefault(); // Never navigate to a dropped file, also when nothing is placed.
    const files = [...event.dataTransfer.files];
    if (skipped || !files.length) return;
    place(files, spot.place);
  });

  document.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || inWriter(event.target) || document.querySelector('dialog[open]')) return;
    // Words with the file (a copied web image) belong in a text field when pasting into one.
    const target = event.target instanceof Element ? event.target : null;
    const typing = target?.closest('input, textarea, [contenteditable="true"]');
    if (typing && event.clipboardData.types.includes('text/plain')) return;
    event.preventDefault();
    const card = (document.activeElement ?? target)?.closest?.('[data-block-card]');
    const inBlocks = card && cards().includes(card);
    place(files, inBlocks && !writer() ? `after:${idOf(card)}` : 'end');
  });

  /** Uploads one drop's files in order, then places the images or shows why not. */
  async function place(files, at) {
    const surface = writer();
    if (surface) {
      surface.dispatchEvent(new CustomEvent('mycel:files', { detail: { files } }));
      return;
    }
    if (uploading) return;
    uploading = true;
    const list = part('progress');
    list.replaceChildren();
    part('place').hidden = true;
    part('results').hidden = false;
    part('dismiss').disabled = true;
    host.hidden = false;
    part('results').scrollIntoView({ block: 'nearest' });
    const images = [];
    let complete = true;
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
      const result = await send(host.dataset.url, file, (value) => (bar.value = value));
      bar.remove();
      if (isImage(result.choice)) {
        images.push(result.choice.id);
        label.textContent = fill(copy.uploaded, { filename: file.name });
      } else {
        complete = false;
        if (result.choice) label.textContent = fill(copy.notImage, { filename: file.name });
        else label.textContent = `${file.name}: ${result.error || copy.failed}`;
        row.classList.add(result.choice ? 'ui-hint' : 'ui-error');
      }
    }
    if (images.length > most) {
      complete = false;
      const row = document.createElement('li');
      row.className = 'ui-hint';
      row.textContent = fill(copy.tooMany, { max: String(most) });
      list.append(row);
    }
    uploading = false;
    part('dismiss').disabled = false;
    const chosen = images.slice(0, most);
    if (!chosen.length) return;
    const submit = () => insert(chosen, at);
    if (complete) return submit();
    const button = part('place');
    button.hidden = false;
    button.onclick = submit;
  }

  /** The screen's own insert, as the block chooser posts it, with the uploaded ids. */
  function insert(ids, at) {
    const media = part('media');
    const button = part('submit');
    media.disabled = false;
    media.value = ids.join(',');
    button.value = `${ids.length === 1 ? 'image' : 'gallery'}|${at}`;
    form.requestSubmit(button);
  }

  // Ready: tests wait for this instead of a timeout.
  host.dataset.ready = '';

  part('dismiss').addEventListener('click', () => {
    if (uploading) return;
    part('results').hidden = true;
    part('progress').replaceChildren();
    host.hidden = true;
  });
}
