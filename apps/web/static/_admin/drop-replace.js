// One image file dropped or pasted on an image that is already there replaces it (brief
// drag-and-drop-upload, table stake 4): on an image block's card, on any image picker of the edit
// screen (the header's image, a gallery row, the featured or share image), and on the picker of a
// block still being added. `block-drop.js` decides that a drop is a replacement and calls this.
// The file goes through `media/upload` with its progress under the picker; then it becomes the
// picker's choice exactly as an upload in the picker's dialog does (`addChoice`), so the form
// holds it until Save like any other choice. The alt text of the locale on screen is emptied and
// takes the focus: a description of the old picture never stands under a new one (the server drops
// the other locales' text at the save, block-form.ts and content-admin.ts). "Undo" puts the
// previous choice and what its fields said back, as "Undo" after a removal puts the block back.
// Rejected: saving the replacement at once, which core refuses without alt text, and keeping the
// old alt text for the new image.
import { send, isImage, progressRow } from './upload-file.js';
import { addChoice, choose } from './media-picker.js';

const IMAGE_PICKER = '[data-media-picker]:not([data-kind])';

/** The alt field and decorative box that describe the image a picker chooses, by name. */
function describing(picker, work) {
  const name = picker.dataset.name ?? '';
  if (name === 'heroImageId') return { text: `heroAlt.${work}`, decorative: 'heroDecorative' };
  if (!name.endsWith('.mediaId')) return null;
  const prefix = name.slice(0, -'mediaId'.length);
  // A standalone image shares the header's explicit all-language clear action. Its old
  // decorative checkbox is gone; snapshot this action too, so Undo restores the actual choice.
  const description = picker
    .closest('form')
    ?.querySelector(`[data-block-alt][data-image-name="${CSS.escape(name)}"]`);
  return {
    text: `${prefix}alt.${work}`,
    decorative: description?.dataset.clearName ?? `${prefix}decorative`,
  };
}

/**
 * What a drop on `target` would replace: `{ picker, marked }`, the picker and the element that
 * shows it is the target, or null. A picker of the writer's own new cards is the writer's.
 */
export function replaceTarget(target, form) {
  if (!(target instanceof Element) || !form.contains(target)) return null;
  const own = target.closest('[data-media-picker]');
  if (own) {
    if (!own.matches(IMAGE_PICKER) || !own.dataset.upload) return null;
    const writer = own.closest('[data-article-writer]');
    if (writer && !own.closest('[data-block-card]')) return null;
    return { picker: own, marked: own };
  }
  const card = target.closest('[data-block-card]');
  if (!card?.querySelector(':scope [data-block-rest] figure.ui-block-image')) return null;
  const picker = card.querySelector(IMAGE_PICKER);
  return picker?.dataset.upload ? { picker, marked: card } : null;
}

/** Makes the fields of `picker` visible: its card expanded and every fold around it open. */
function reveal(picker) {
  const card = picker.closest('[data-block-card]');
  if (card && 'collapsed' in card.dataset) card.querySelector('[data-block-toggle]')?.click();
  for (let d = picker.closest('details'); d; d = d.parentElement?.closest('details') ?? null)
    d.open = true;
}

/** The visible control of a name: a box can come with a hidden field of the same name. */
const control = (form, name) =>
  name ? form.querySelector(`[name="${CSS.escape(name)}"]:not([type="hidden"])`) : null;
const say = (element, type) => element.dispatchEvent(new Event(type, { bubbles: true }));

/** Uploads `file` and makes it the choice of `picker`, with Undo. `copy` holds the words. */
export async function replace(picker, file, { form, work, copy }) {
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
  reveal(picker);
  let status = picker.querySelector(':scope > [data-replace-status]');
  if (!status) {
    status = document.createElement('ul');
    status.className = 'ui-media-uploads';
    status.dataset.replaceStatus = '';
    status.setAttribute('aria-live', 'polite');
    picker.querySelector(':scope > .ui-media-picker-selection')?.after(status);
  }
  const { row, label, bar } = progressRow(fill(copy.uploading, { filename: file.name }));
  status.replaceChildren(row);
  row.scrollIntoView({ block: 'nearest' });
  const result = await send(picker.dataset.upload, file, (value) => (bar.value = value));
  bar.remove();
  if (!isImage(result.choice)) {
    row.classList.add(result.choice ? 'ui-hint' : 'ui-error');
    label.textContent = result.choice
      ? fill(copy.notImage, { filename: file.name })
      : `${file.name}: ${result.error || copy.failed}`;
    return;
  }

  // What stands now, for Undo: the choice, its description and the card's picture at rest.
  const radios = () =>
    [...picker.querySelectorAll('input[type="radio"]')].filter(
      (i) => i.name === picker.dataset.name
    );
  const before = radios().find((i) => i.checked);
  const names = describing(picker, work);
  const text = control(form, names?.text);
  const box = control(form, names?.decorative);
  const was = { text: text?.value, decorative: box?.checked };
  const rest = picker.closest('[data-block-card]')?.querySelector('img[data-block-image]');
  const figure = rest?.closest('figure');
  const restWas = { src: rest?.getAttribute('src'), broken: figure?.hasAttribute('data-broken') };
  // A card without a caption goes by its file's name (edit-screen.js `renameCard`).
  const name = picker.closest('[data-block-card]')?.querySelector('[data-block-name]');
  const nameWas = name && { text: name.textContent, file: name.dataset.blockName ?? '' };

  const chosen = addChoice(picker, result.choice);
  if (rest && chosen.dataset.thumb) {
    rest.src = chosen.dataset.thumb;
    figure.removeAttribute('data-broken');
  }
  if (name && nameWas) {
    if (nameWas.text?.trim() === nameWas.file) name.textContent = chosen.dataset.label ?? '';
    name.dataset.blockName = chosen.dataset.label ?? '';
  }
  if (box instanceof HTMLInputElement && box.checked) {
    box.checked = false;
    say(box, 'change');
  }
  if (text instanceof HTMLInputElement || text instanceof HTMLTextAreaElement) {
    text.value = '';
    say(text, 'input');
    for (let d = text.closest('details'); d; d = d.parentElement?.closest('details') ?? null)
      d.open = true;
    text.focus();
  }
  label.textContent = fill(text ? copy.replacedDescribe : copy.replaced, {
    filename: file.name,
  });
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'ui-button secondary';
  undo.textContent = copy.undo;
  row.append(undo);
  undo.addEventListener('click', () => {
    if (before) choose(before);
    if (box instanceof HTMLInputElement && box.checked !== was.decorative) {
      box.checked = !!was.decorative;
      say(box, 'change');
    }
    if (text && was.text !== undefined) {
      text.value = was.text;
      say(text, 'input');
    }
    if (rest && restWas.src) rest.src = restWas.src;
    if (figure && restWas.broken) figure.setAttribute('data-broken', '');
    if (name && nameWas) {
      name.textContent = nameWas.text;
      name.dataset.blockName = nameWas.file;
    }
    label.textContent = copy.undone;
    undo.remove();
    picker.querySelector('button[command="show-modal"]')?.focus();
  });
}
