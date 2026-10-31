// The edit screen's controls with JavaScript (#66 PR 6, MY-110 A, brief edit-screen § 6 and
// block-editor-interactions § A6). Everything here has a native route the server already serves:
// the form saves and acts without it, every fold is a `details`, and an issue link is a fragment.
// The script adds what only a script can:
// - the save state in the item bar ("Unsaved changes", "Saving…") and a leave warning while the
//   form has changes nobody saved; any submit of the form saves first, so it ends both;
// - Ctrl+S / Cmd+S saves through the bar's Save button (`requestSubmit`, so a refused field is
//   shown as on a click);
// - Escape closes the innermost open block fold, "More actions" or confirmation and gives focus
//   back to its summary; it never touches what was typed;
// - a "Done" under a block's fields that closes it like its summary does, and a click on the
//   block at rest that opens it;
// - focus after a round trip lands where the action was: the moved block's "More actions", the
//   copy's or neighbour's "Edit", the first field of a new block;
// - a link or a refused control inside a closed fold opens that fold first (the tabs script
//   shows a hidden tab the same way), so the browser can scroll to it and focus it;
// - an image block's alt text hides while the image is decorative and the field is empty, and a
//   picture that fails to load turns its card into the "not available" state;
// - a search field over each block type list that narrows it, Enter adding the first match;
// - a shortcuts panel that `?` opens (outside text fields).
// Rejected: autosave (brief § 5: every pause would be a revision), a custom leave dialog
// (browsers only allow their own), and comparing every field with its initial value (a value
// typed and typed back still counts as a change, which errs on the side of asking).
const form = document.getElementById('item-edit');

if (form instanceof HTMLFormElement) {
  const state = document.querySelector('[data-save-state]');
  const saveButton = document.querySelector('button[form="item-edit"][formaction="?/save"]');
  /** Controls that choose an action rather than change the document. */
  const IGNORED = /^(insertType\.|at\.|patternId$)/;
  // A refused save comes back with what was typed, still unsaved: leaving asks from the start.
  let dirty = !!state?.hasAttribute('data-refused');
  let submitting = false;

  /** Shows one of the bar's save states; they share a cell, so nothing moves. */
  const say = (which) => {
    if (!(state instanceof HTMLElement)) return;
    state.dataset.current = which;
    const live = state.querySelector('[data-save-live]');
    const words = state.querySelector(`[data-state="${which}"]`);
    if (live && words) live.textContent = words.textContent;
  };
  const mark = (event) => {
    const target = event.target;
    if (target instanceof Element && IGNORED.test(target.getAttribute('name') ?? '')) return;
    if (target instanceof Element && target.closest('[data-type-search]')) return;
    if (dirty) return;
    dirty = true;
    say('unsaved');
  };
  form.addEventListener('input', mark);
  form.addEventListener('change', mark);
  form.addEventListener('submit', (event) => {
    submitting = true;
    say('saving');
    // Another listener (the article writer with an unfinished card) may still stop the submit;
    // then the page stays and its changes are still unsaved.
    setTimeout(() => {
      if (!event.defaultPrevented) return;
      submitting = false;
      say(dirty ? 'unsaved' : 'none');
    });
  });
  window.addEventListener('beforeunload', (event) => {
    if (dirty && !submitting) event.preventDefault();
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (saveButton instanceof HTMLButtonElement && !submitting) form.requestSubmit(saveButton);
      return;
    }
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    // A dialog (the media picker) closes itself; an open menu of the prose editor goes first.
    if (!target || target.closest('dialog')) return;
    const fold = target.closest(
      'details.ui-confirm[open], details.ui-block-card-more[open], details.ui-block-card-fold[open], details.ui-block-insert[open], details[data-shortcuts][open]'
    );
    if (!fold) return;
    event.preventDefault();
    close(fold);
  });

  /** Closes a fold and puts focus on its summary, scrolled into view if it left it. */
  const close = (fold) => {
    fold.open = false;
    const summary = fold.querySelector(':scope > summary');
    summary?.focus({ preventScroll: true });
    summary?.scrollIntoView({ block: 'nearest' });
  };

  for (const done of form.querySelectorAll('[data-block-done]')) {
    done.hidden = false;
    done.querySelector('button')?.addEventListener('click', () => {
      const fold = done.closest('details');
      if (fold) close(fold);
    });
  }
  form.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const rest = target?.closest('[data-block-rest]');
    if (!rest || target.closest('a, button, summary')) return;
    const fold = rest.parentElement?.querySelector(':scope > details.ui-block-card-fold');
    if (!fold || fold.open) return;
    fold.open = true;
    fold.querySelector(':scope > summary')?.focus();
  });

  /** Opens every closed fold around an element, so it can be shown and focused. */
  const reveal = (element) => {
    for (let d = element.closest('details'); d; d = d.parentElement?.closest('details') ?? null)
      d.open = true;
  };
  document.addEventListener(
    'click',
    (event) => {
      const link = event.target instanceof Element && event.target.closest('a[href^="#"]');
      const id = link && decodeURIComponent(link.getAttribute('href').slice(1));
      const target = id && document.getElementById(id);
      if (target) reveal(target);
    },
    true
  );
  form.addEventListener(
    'invalid',
    (event) => event.target instanceof Element && reveal(event.target),
    true
  );

  /** After a round trip: focus the control the action belongs to (brief § A6). */
  const land = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id && document.getElementById(id);
    if (!target) return;
    // A block lands at rest: open what is around it, not its own fold.
    if (target.parentElement) reveal(target.parentElement);
    if (id === 'block-new') {
      target.querySelector('input:not([type="hidden"]), select, textarea')?.focus();
      return;
    }
    if (id === 'blocks' && target instanceof HTMLElement) {
      target.tabIndex = -1;
      target.focus();
      return;
    }
    if (!target.matches('details.ui-block-card-fold')) return;
    const moved = new URLSearchParams(location.search).get('done') === 'blockMoved';
    const card = target.closest('[data-block-card]');
    const summary = moved
      ? card?.querySelector('details.ui-block-card-more > summary')
      : target.querySelector(':scope > summary');
    summary?.focus({ preventScroll: true });
  };
  land();

  // An image's alt text only applies while it is not decorative; a filled one stays in view, so
  // the refusal a save would give is never about a field nobody can see.
  for (const alt of form.querySelectorAll('[data-alt-of]')) {
    const box = form.querySelector(
      `input[type="checkbox"][name="${CSS.escape(alt.dataset.altOf)}"]`
    );
    if (!(box instanceof HTMLInputElement)) continue;
    const sync = () => {
      const empty = [...alt.querySelectorAll('input, textarea')].every((f) => !f.value.trim());
      alt.hidden = box.checked && empty;
    };
    box.addEventListener('change', sync);
    sync();
  }

  const broken = (img) => img.closest('figure')?.setAttribute('data-broken', '');
  document.addEventListener(
    'error',
    (event) =>
      event.target instanceof HTMLImageElement &&
      event.target.matches('[data-block-image]') &&
      broken(event.target),
    true
  );
  for (const img of form.querySelectorAll('img[data-block-image]'))
    if (img.complete && img.naturalWidth === 0) broken(img);
  // Block type search: rebuilds the list from its original options, so the select keeps posting
  // a valid type; nothing found leaves one disabled line and the insert button refuses nothing.
  for (const search of form.querySelectorAll('[data-type-search]')) {
    const input = search.querySelector('input');
    const select = search.parentElement?.querySelector('select');
    const button = search.parentElement?.querySelector('button[formaction="?/insert"]');
    if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement)) continue;
    search.hidden = false;
    const all = [...select.options].map((o) => o.cloneNode(true));
    const none = document.createElement('option');
    none.disabled = true;
    none.textContent = search.dataset.none ?? '';
    input.addEventListener('input', () => {
      const q = input.value.trim().toLocaleLowerCase();
      const shown = all.filter((o) => !q || o.textContent.toLocaleLowerCase().includes(q));
      select.replaceChildren(...(shown.length ? shown.map((o) => o.cloneNode(true)) : [none]));
      if (shown.length) select.selectedIndex = 0;
      if (button instanceof HTMLButtonElement) button.disabled = !shown.length;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      // Enter in a text field would save the whole form; here it adds the type that matched.
      event.preventDefault();
      if (button instanceof HTMLButtonElement && !button.disabled) form.requestSubmit(button);
    });
  }

  // Shortcuts panel: a fold the script shows; `?` outside a text field opens it.
  const keys = document.querySelector('details[data-shortcuts]');
  if (keys instanceof HTMLDetailsElement) {
    keys.hidden = false;
    document.addEventListener('keydown', (event) => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], .ProseMirror'))
        return;
      event.preventDefault();
      keys.open = true;
      const summary = keys.querySelector(':scope > summary');
      summary?.focus({ preventScroll: true });
      summary?.scrollIntoView({ block: 'nearest' });
    });
  }

  // The bar's real height while it stays in view (ui.css `--item-bar-block-size`): a long title
  // wraps it to two lines, and the open preview and a fragment then start below that, not under
  // it. Where the bar scrolls along, the stylesheet's own value (none) holds.
  const bar = document.querySelector('.ui-item-bar');
  if (bar instanceof HTMLElement && 'ResizeObserver' in window) {
    const root = document.documentElement;
    const measure = () => {
      if (getComputedStyle(bar).position === 'sticky')
        root.style.setProperty('--item-bar-block-size', `${bar.getBoundingClientRect().height}px`);
      else root.style.removeProperty('--item-bar-block-size');
    };
    new ResizeObserver(measure).observe(bar);
    window.addEventListener('resize', measure);
  }

  // Ready: tests wait for this instead of a timeout.
  form.dataset.editScreen = '';
}
