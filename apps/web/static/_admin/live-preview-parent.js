// Progressive enhancement for TODO #11 D. The native save and saved-preview links remain usable
// without this script. Form submissions target only our same-origin iframe; no draft is persisted.
// The edit form carries every block's fields since #66 PR 2, so one copy of it is the draft.
//
// Since #66 PR 3 the preview is a toggle in the ItemBar (an eye, `aria-pressed`): closed by
// default, it opens as a column beside the text from 75rem and under it below that, and the side
// column steps aside meanwhile (ui.css, `data-preview-open` on the form). The browser remembers
// the choice, as it does the menu's rail (nav.js). The toggle and the saved-preview links in the
// bar swap places through `data-live-preview-ready` on <html>, so without this script the links stay
// and there is no dead button. A draft is only posted while the preview is open. Rejected: the
// preview always open under the content, out of sight below a long page (Payload's live preview
// is a toggle beside the fields too).
//
// Since #66 PR 6d a draft renders into a second, hidden frame, which takes the visible one's place
// only once it rendered (`data-live-preview-rendered` in the draft page). A draft the server
// refuses (a field it cannot read yet, an expired session) leaves the last good image in view and
// says that it is behind (`data-preview-state` on the panel's status line), instead of replacing
// the page with an error. The scroll position carries over to the frame that takes over. Rejected:
// fetching the draft and writing it into the frame (the frame's own CSP and nonces would have to
// be rebuilt) and re-posting the last good draft after a refusal (a flash of the error page).
const source = document.querySelector('[data-live-preview-source]');
const panel = document.querySelector('[data-live-preview]');
const frame = panel?.querySelector('[data-live-preview-frame]');
const locale = panel?.querySelector('[data-live-preview-locale]');
const toggle = document.querySelector('[data-preview-toggle]');
const KEY = 'mycel.admin.preview';

if (
  source instanceof HTMLFormElement &&
  panel &&
  frame instanceof HTMLIFrameElement &&
  locale &&
  toggle
) {
  document.documentElement.dataset.livePreviewReady = '';
  const status = panel.querySelector('[data-preview-state]');
  /** The frame in view, and the hidden one the next draft renders into. */
  let shown = frame;
  const spare = frame.cloneNode();
  spare.name = `${frame.name}-next`;
  spare.removeAttribute('data-live-preview-frame');
  spare.hidden = true;
  spare.tabIndex = -1;
  spare.setAttribute('aria-hidden', 'true');
  frame.after(spare);
  let next = spare;
  const say = (state) => {
    if (status instanceof HTMLElement && status.dataset.previewState !== state)
      status.dataset.previewState = state;
  };
  const landed = () => {
    // A load of about:blank (the frame just inserted) is no answer to a draft.
    if (next.contentWindow?.location.href === 'about:blank') return;
    if (!next.contentDocument?.querySelector('[data-live-preview-rendered]')) return say('behind');
    const y = shown.contentWindow?.scrollY ?? 0;
    shown.hidden = true;
    shown.tabIndex = -1;
    shown.setAttribute('aria-hidden', 'true');
    shown.removeAttribute('data-live-preview-frame');
    next.hidden = false;
    next.removeAttribute('tabindex');
    next.removeAttribute('aria-hidden');
    next.setAttribute('data-live-preview-frame', '');
    [shown, next] = [next, shown];
    shown.contentWindow?.scrollTo(0, y);
    say('current');
  };
  frame.addEventListener('load', () => frame === next && landed());
  spare.addEventListener('load', () => spare === next && landed());
  let pending;
  const render = () => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = panel.dataset.previewAction;
    form.target = next.name;
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
    document.body.append(form);
    form.submit();
    form.remove();
  };
  const schedule = () => {
    clearTimeout(pending);
    if (!panel.hidden) pending = setTimeout(render, 300);
  };
  const show = (open, remember = true) => {
    panel.hidden = !open;
    source.toggleAttribute('data-preview-open', open);
    toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (open) render();
    if (!remember) return;
    try {
      localStorage.setItem(KEY, open ? 'open' : 'closed');
    } catch {
      // Storage blocked (private mode, a policy): the toggle still works for this page.
    }
  };
  toggle.addEventListener('click', () => show(panel.hidden));
  // A link into the side column (the state in the bar, an issue in the status card) closes the
  // preview, so it never points at a column that stepped aside.
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element && event.target.closest('a[href^="#"]');
    const target = link && document.getElementById(link.getAttribute('href').slice(1));
    if (!panel.hidden && target?.closest('.ui-edit-side')) show(false);
  });
  source.addEventListener('input', schedule);
  source.addEventListener('change', schedule);
  locale.addEventListener('change', schedule);
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== shown.contentWindow) return;
    if (event.data?.type !== 'mycel:block-select') return;
    const id = event.data.blockId;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return;
    const details = document.getElementById(`block-${id}`);
    if (!(details instanceof HTMLDetailsElement)) return;
    // Through the hash, so the tabs (tabs.js) show the panel the block is in.
    history.replaceState(history.state, '', `#block-${id}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    details.open = true;
    details.scrollIntoView({ block: 'center' });
    details.querySelector('summary')?.focus();
  });
  let stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // As above: closed, as by default.
  }
  show(stored === 'open', false);
}
