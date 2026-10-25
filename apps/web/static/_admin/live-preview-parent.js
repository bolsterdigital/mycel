// Progressive enhancement for TODO #11 D. The native save and saved-preview links remain usable
// without this script. Form submissions target only our same-origin iframe; no draft is persisted.
const source = document.querySelector('[data-live-preview-source]');
const panel = document.querySelector('[data-live-preview]');
const frame = panel?.querySelector('[data-live-preview-frame]');
const locale = panel?.querySelector('[data-live-preview-locale]');

if (source instanceof HTMLFormElement && panel && frame instanceof HTMLIFrameElement && locale) {
  panel.hidden = false;
  let pending;
  const render = () => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = panel.dataset.previewAction;
    form.target = frame.name;
    form.hidden = true;
    const add = (name, value) => {
      if (typeof value !== 'string') return;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    };
    for (const [name, value] of new FormData(source)) add(name, value);
    add('itemId', panel.dataset.itemId);
    add('previewLocale', locale.value);
    for (const blockForm of document.querySelectorAll(
      'details.block form[data-live-block-dirty]'
    )) {
      const id = blockForm.querySelector('[name="blockId"]')?.value;
      if (!/^[0-9a-f-]{36}$/.test(id ?? '')) continue;
      for (const [name, value] of new FormData(blockForm)) add(`draftBlock.${id}.${name}`, value);
    }
    document.body.append(form);
    form.submit();
    form.remove();
  };
  const schedule = () => {
    clearTimeout(pending);
    pending = setTimeout(render, 300);
  };
  source.addEventListener('input', schedule);
  source.addEventListener('change', schedule);
  locale.addEventListener('change', schedule);
  for (const blockForm of document.querySelectorAll('details.block form[action*="setProps"]')) {
    blockForm.addEventListener('input', () => {
      blockForm.dataset.liveBlockDirty = '';
      schedule();
    });
    blockForm.addEventListener('change', () => {
      blockForm.dataset.liveBlockDirty = '';
      schedule();
    });
  }
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type !== 'mycel:block-select') return;
    const id = event.data.blockId;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return;
    const details = document.getElementById(`block-${id}`);
    if (!(details instanceof HTMLDetailsElement)) return;
    details.open = true;
    details.scrollIntoView({ block: 'center' });
    details.querySelector('summary')?.focus();
  });
  render();
}
