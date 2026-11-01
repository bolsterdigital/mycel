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
//   block at rest that opens it, with a text block's words brought up to date when it closes
//   and a click on them landing in the field they came from;
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
  // The form says so too, for session-restore.js: it keeps what a submit sends only while
  // something is unsaved, from this one source rather than its own detection.
  form.toggleAttribute('data-has-unsaved', dirty);

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
    form.setAttribute('data-has-unsaved', '');
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
  // A link that throws the unsaved input away on purpose ("Discard" after a restore) leaves
  // without asking: the click was the question.
  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a[data-discard]')) dirty = false;
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
    if (event.key !== 'Escape') return;
    const target = event.target instanceof Element ? event.target : null;
    // ProseMirror marks every Escape as handled without doing anything with it, so only there a
    // prevented one still closes the block. A dialog (the media picker) closes itself.
    if (!target || target.closest('dialog')) return;
    if (event.defaultPrevented && !target.closest('.ProseMirror')) return;
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
  let rememberFold = () => {};
  form.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const rest = target?.closest('[data-block-rest]');
    if (!rest || target.closest('a, button, summary')) return;
    const fold = rest.parentElement?.querySelector(':scope > details.ui-block-card-fold');
    if (!fold || fold.open) return;
    rememberFold(fold);
    fold.open = true;
    // A click on the words is a wish to write them: into the field they came from, else the first.
    const field = rest.querySelector('.ui-block-text')
      ? (sourceOf(target) ??
        [...fold.querySelectorAll('.ProseMirror, input:not([type="hidden"]), textarea')].find(
          shown
        ))
      : null;
    (field ?? fold.querySelector(':scope > summary'))?.focus();
  });

  // A closed block says what its fields say now, not what was last saved (MY-110 C1, C2). Without
  // JavaScript the rest view stays the saved text until the save; the fields keep what was typed.
  const controlOf = (name) => form.elements.namedItem(name);
  const valueOf = (names) => {
    for (const name of names.split('|')) {
      const control = controlOf(name);
      if (control?.value) return control.value;
    }
    return '';
  };
  /** The editor that writes to a `.editor` field: it follows that field's hidden input. */
  const editorOf = (name) => controlOf(name)?.nextElementSibling?.querySelector('.ProseMirror');
  /** The field a word at rest came from, when it can take the focus. */
  const shown = (control) => control.getClientRects().length > 0;
  const sourceOf = (target) => {
    const prose = target.closest('[data-rest-prose]')?.dataset.restProse;
    if (prose) {
      const control = editorOf(prose) ?? controlOf(prose.replace(/\.editor$/, ''));
      if (control && shown(control)) return control;
    }
    const names = target.closest('[data-rest-from]')?.dataset.restFrom?.split(/[ |]/) ?? [];
    return names.map(controlOf).find((control) => control?.getClientRects && shown(control));
  };
  /** What every field held on load (Svelte's hydration clears `defaultValue`, so it says nothing). */
  const loaded = new Map([...form.elements].map((control) => [control.name, control.value]));
  const typedInto = (names) =>
    names.split(/[ |]/).some((name) => controlOf(name)?.value !== loaded.get(name));
  const PROSE_TAGS = new Set(['P', 'STRONG', 'EM', 'CODE', 'UL', 'OL', 'LI', 'BR', 'SUP']);
  /** The editor's words as the inert markup of `rich-text.ts`, built from its nodes, no copies. */
  const inertCopy = (source, target) => {
    for (const node of source.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) target.append(node.textContent ?? '');
      if (!(node instanceof Element)) continue;
      let copy = null;
      if (/^H[1-6]$/.test(node.tagName)) {
        copy = document.createElement('p');
        copy.dataset.heading = node.tagName.slice(1);
      } else if (node.tagName === 'A') {
        copy = document.createElement('span');
        copy.dataset.link = '';
      } else if (PROSE_TAGS.has(node.tagName)) {
        copy = document.createElement(node.tagName);
      }
      if (copy) target.append(copy);
      inertCopy(node, copy ?? target);
    }
  };
  /** What each editor held when its fold opened: an unchanged one keeps the server's rendering. */
  const opened = new WeakMap();
  /**
   * The words the server set per source: what stays while its fields are as they were loaded,
   * which may be another locale's fallback. By source, since an FAQ's rows are set anew.
   */
  const served = new Map(
    [...form.querySelectorAll('[data-rest-from]')].map((line) => [
      line.dataset.restFrom,
      line.textContent,
    ])
  );
  const fieldsOf = (fold) =>
    [...fold.querySelectorAll('input:not([type="hidden"]), textarea, select')]
      .map((control) => control.value)
      .join('\0');
  /** An FAQ whose rows changed is set again: its rows and its variant decide the elements. */
  const rebuildEntries = (faq, place) => {
    const { restList: list, restLocale: locale } = faq.dataset;
    const accordion = controlOf(faq.dataset.restVariant)?.value === 'accordion';
    const previous = new Map(
      [...place.querySelectorAll('[data-rest-prose]')].map((el) => [el.dataset.restProse, el])
    );
    const entries = [];
    for (let i = 0; i < Number(controlOf(`${list}.rows`)?.value ?? 0); i++) {
      const from = `${list}.${i}.question.${locale}`;
      const proseFrom = `${list}.${i}.answer.${locale}.editor`;
      const question = typedInto(from) ? valueOf(from) : (served.get(from) ?? '');
      const editor = editorOf(proseFrom);
      const nativeName = proseFrom.replace(/\.editor$/, '');
      const native = controlOf(nativeName)?.value ?? '';
      // An answer nobody touched keeps what the server set, which may be a fallback.
      const kept = previous.get(proseFrom);
      const untouched = editor
        ? editor.innerHTML === opened.get(editor)
        : native === loaded.get(nativeName);
      const words = kept && untouched ? kept.textContent : editor ? editor.textContent : native;
      if (!question && !words?.trim()) continue;
      const answer = document.createElement('div');
      answer.className = 'ui-block-text-prose';
      answer.dataset.restProse = proseFrom;
      if (kept && untouched) {
        answer.append(...kept.childNodes);
      } else if (editor) {
        inertCopy(editor, answer);
      } else {
        const line = document.createElement('p');
        line.textContent = native;
        answer.append(line);
      }
      const entry = document.createElement(accordion ? 'details' : 'div');
      entry.className = 'ui-block-text-entry';
      const label = document.createElement(accordion ? 'span' : 'p');
      label.dataset.restFrom = from;
      label.textContent = question;
      if (accordion) {
        const summary = document.createElement('summary');
        summary.append(label);
        entry.append(summary);
      } else {
        label.className = 'ui-block-text-question';
        entry.append(label);
      }
      entry.append(answer);
      entries.push(entry);
    }
    place.replaceChildren(...entries);
  };
  /** What the plain fields of a fold held when it opened. */
  const restFolds = new WeakMap();
  // Also called from the click that opens a fold: `toggle` comes a task later, after a fast typist.
  rememberFold = (fold) => {
    if (restFolds.has(fold)) return;
    for (const editor of fold.querySelectorAll('.ProseMirror'))
      opened.set(editor, editor.innerHTML);
    restFolds.set(fold, fieldsOf(fold));
  };
  form.addEventListener(
    'toggle',
    (event) => {
      const fold = event.target;
      if (!(fold instanceof HTMLDetailsElement) || !fold.matches('.ui-block-card-fold')) return;
      const editors = fold.querySelectorAll('.ProseMirror');
      if (fold.open) {
        rememberFold(fold);
        return;
      }
      const rest = fold.parentElement?.querySelector(':scope > [data-block-rest]');
      if (!rest) return;
      const entries = rest.querySelector('[data-rest-entries]');
      const edited =
        restFolds.get(fold) !== fieldsOf(fold) ||
        [...editors].some((editor) => editor.innerHTML !== opened.get(editor));
      restFolds.delete(fold);
      if (entries && edited) rebuildEntries(entries.closest('[data-rest-list]'), entries);
      for (const line of rest.querySelectorAll('[data-rest-from]')) {
        const names = line.dataset.restFrom;
        if (!names) continue;
        // Untouched fields keep the server's words, which may be another locale's fallback; an
        // emptied one is empty, as the save will make it.
        line.textContent = typedInto(names)
          ? names.split(' ').map(valueOf).filter(Boolean).join(', ')
          : (served.get(names) ?? '');
      }
      for (const note of rest.querySelectorAll('[data-rest-changed]')) {
        note.hidden = !typedInto(note.dataset.restChanged);
      }
      for (const box of rest.querySelectorAll('[data-rest-variant]')) {
        const value = controlOf(box.dataset.restVariant)?.value;
        if (value) box.dataset.variant = value;
      }
      for (const kind of rest.querySelectorAll('[data-rest-option]')) {
        const text = controlOf(kind.dataset.restOption)?.selectedOptions?.[0]?.textContent;
        if (text) kind.textContent = text;
      }
      for (const prose of rest.querySelectorAll('[data-rest-prose]')) {
        const editor = editorOf(prose.dataset.restProse);
        if (!editor || editor.innerHTML === opened.get(editor)) continue;
        prose.replaceChildren();
        inertCopy(editor, prose);
      }
    },
    true
  );

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
