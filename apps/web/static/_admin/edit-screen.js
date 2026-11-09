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
// - the hero's description line says what the fields say now (#158), and clears what described
//   the previous picture when another image is chosen;
// - an image block's alt text hides while the image is decorative and the field is empty, and a
//   picture that fails to load turns its card into the "not available" state;
// - collapsing a block card and every card, remembered per browser and item, without leaving the
//   form: a collapsed block's fields still save, and one that a refusal or link needs opens itself,
//   with focus on the refused field;
// - "Insert a block below" opening the chooser it points at, and one open "More actions" at a time;
// - a search field over each block type list that narrows it, Enter adding the first match;
// - a shortcuts panel that `?` opens (outside text fields).
// Rejected: autosave (brief § 5: every pause would be a revision), a custom leave dialog
// (browsers only allow their own), and comparing every field with its initial value (a value
// typed and typed back still counts as a change, which errs on the side of asking).
import { selectBlockName } from './block-name.js';

const form = document.getElementById('item-edit');

if (form instanceof HTMLFormElement) {
  const state = document.querySelector('[data-save-state]');
  const saveButton = document.querySelector('button[form="item-edit"][formaction^="?/save&"]');
  /** Controls that choose an action rather than change the document. */
  const IGNORED = /^(insertType\.|at\.|patternId$)/;
  // A refused save comes back with what was typed, still unsaved: leaving asks from the start.
  // So does a block made of dropped images: it is only stored once its alt text is written.
  const dropped = form.querySelector('#block-new[data-dropped]');
  let dirty = !!state?.hasAttribute('data-refused') || !!dropped;
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
  if (dropped) say('unsaved');
  form.addEventListener('input', mark);
  form.addEventListener('change', mark);
  /** The id of the block in view, unless the top of the first one still is: then the top is fine. */
  const blockInView = () => {
    const cards = [...form.querySelectorAll('[data-block-card]')];
    // A prose card of the writer has no box, so its bottom never counts as in view.
    const card = cards.find((c) => c.getBoundingClientRect().bottom > innerHeight / 4);
    if (!card || (card === cards[0] && card.getBoundingClientRect().top > 0)) return '';
    return card.dataset.blockCard.replace(/^block-/, '');
  };
  form.addEventListener('submit', (event) => {
    submitting = true;
    say('saving');
    const near = form.elements.namedItem('nearBlock');
    if (near instanceof HTMLInputElement) near.value = blockInView();
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
      'details.ui-confirm[open], details.ui-block-card-more[open], details.ui-block-card-fold[open], details.ui-block-insert[open], details[data-shortcuts][open], details[data-hero-alt][open]'
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
    // The browser opens a fold after this click, and `toggle` comes a task later: what it holds now
    // is what it held on opening, even when the words arrive before that task.
    const opening = target?.closest('details.ui-block-card-fold:not([open]) > summary');
    if (opening) rememberFold(opening.parentElement);
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
  /** A card's name follows its rest view once that is up to date, so the two never disagree. */
  const renameCard = (rest) => {
    const name = rest.closest('[data-block-card]')?.querySelector('[data-block-name]');
    if (!name) return;
    const card = rest.closest('[data-block-card]');
    const field = card?.querySelector('[data-block-naming]');
    if (!field) return;
    const data = JSON.parse(field.dataset.blockNaming);
    const input = field.querySelector('[data-editorial-name]');
    const names = { ...data.names, [data.locale]: input.value };
    const candidates = data.candidates.map((candidate) => {
      const values = { ...candidate.values };
      const from =
        candidate.localized === false ? candidate.field : `${candidate.field}.${data.locale}`;
      const native = controlOf(from);
      const prose = controlOf(`${from}.editor`);
      if (candidate.rich) {
        // The enhanced editor posts validated ProseMirror JSON; use its text, never its HTML.
        if (prose?.value) {
          const words = (n) => n.text ?? (n.content ?? []).map(words).join(' ');
          try {
            values[data.locale] = words(JSON.parse(prose.value));
          } catch {
            /* Keep the last valid candidate. */
          }
        } else if (native && typedInto(from)) values[data.locale] = native.value;
      } else if (native) {
        const mode = controlOf(`${from}.mode`)?.value;
        values[data.locale] =
          mode === 'inherit'
            ? (candidate.inherited?.[data.locale] ?? '')
            : mode === 'hide'
              ? ''
              : native.value;
        if (candidate.localized === false) values[data.fallback] = native.value;
      }
      return values;
    });
    const selected = selectBlockName(
      names,
      candidates,
      data.locale,
      data.fallback,
      name.dataset.blockName || data.file
    );
    name.textContent = selected.name;
    input.placeholder = selected.automatic;
  };
  form.addEventListener('input', (event) => {
    const card = event.target.closest?.('[data-block-card]');
    const rest = card?.querySelector('[data-block-rest]');
    if (rest) renameCard(rest);
  });
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
      if (edited) queueMicrotask(() => renameCard(rest));
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
      // A caption by its mode, as a save reads it: the file's words, none, or the block's own.
      for (const line of rest.querySelectorAll('[data-rest-caption]')) {
        const name = line.dataset.restCaption;
        const mode = controlOf(`${name}.mode`)?.value;
        const words =
          mode === 'inherit'
            ? (line.dataset.restInherited ?? '')
            : mode === 'hide'
              ? ''
              : (controlOf(name)?.value ?? '');
        line.textContent = words;
        line.hidden = !words.trim();
        const caption = line.closest('figcaption');
        if (caption) caption.hidden = [...caption.children].every((child) => child.hidden);
      }
      for (const line of rest.querySelectorAll('[data-rest-alt]')) {
        const text = controlOf(line.dataset.restAlt)?.value ?? '';
        const description = fold.querySelector('[data-block-alt]');
        const decorative = description
          ? !!description.querySelector('input[type="checkbox"]')?.checked ||
            (!text.trim() &&
              (Number(description.dataset.storedOthers) === 0 ||
                description.dataset.savedImage !== controlOf(description.dataset.imageName)?.value))
          : !!controlOf(line.dataset.restDecorative)?.checked;
        const words = line.querySelector('[data-rest-alt-text]');
        const intentional = line.querySelector('[data-rest-alt-decorative]');
        const missing = line.querySelector('[data-rest-alt-missing]');
        if (words) {
          words.textContent = text;
          words.hidden = decorative || !text.trim();
        }
        if (intentional) intentional.hidden = !decorative;
        if (missing) missing.hidden = decorative || !!text.trim();
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

  // Collapsing a card (#159). The content goes `hidden`, not out of the form: what was typed in it
  // is posted with the save. Standing in the page's markup would make it a promise without a
  // script, so the buttons appear here and the page without JavaScript shows every block open.
  // Remembered per browser and per item, not in the document: rest is one reader's view of it.
  // Rejected: the server remembering it (a save for a glance) and `details` for the head, which
  // would hide the head's own controls from a `summary` and name the button after all its text.
  const allCards = () => [...form.querySelectorAll('[data-block-card]')];
  const contentOf = (card) => card.querySelector(':scope > [data-block-content]');
  const collapsedKey = `mycel:collapsed-blocks:${location.pathname}`;
  const readCollapsed = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]');
      return new Set(Array.isArray(stored) ? stored : []);
    } catch {
      return new Set();
    }
  };
  const remember = () => {
    const ids = allCards()
      .filter((card) => 'collapsed' in card.dataset)
      .map((card) => card.dataset.blockCard);
    try {
      if (ids.length) localStorage.setItem(collapsedKey, JSON.stringify(ids));
      else localStorage.removeItem(collapsedKey);
    } catch {
      // Private window or blocked storage: it just is not remembered.
    }
  };
  const setCollapsed = (card, collapsed) => {
    const content = contentOf(card);
    if (!content) return;
    content.hidden = collapsed;
    card.toggleAttribute('data-collapsed', collapsed);
    card.querySelector('[data-block-toggle]')?.setAttribute('aria-expanded', String(!collapsed));
  };
  /** Expands the card around an element and forgets it was collapsed. */
  const expandAround = (element) => {
    const card = element.closest('[data-block-card]');
    if (!card || !('collapsed' in card.dataset)) return;
    setCollapsed(card, false);
    remember();
  };
  /** What a card must show on arrival, whatever was remembered (a block that needs attention). */
  const landingId = decodeURIComponent(location.hash.slice(1));
  // A block moved up or down stays as it was: it was probably collapsed to be moved around. Its
  // "More actions" takes the focus (`land`), and that is in the head.
  const landingMoved = new URLSearchParams(location.search).get('done') === 'blockMoved';
  const needed = (card) => {
    if (card.querySelector('[aria-invalid="true"], .ui-error')) return true;
    if (card.querySelector(':scope > [data-block-content] > details.ui-block-card-fold[open]'))
      return true;
    const target = landingId && document.getElementById(landingId);
    return !!target && card.contains(target) && !landingMoved;
  };
  const remembered = readCollapsed();
  for (const card of allCards()) {
    card.querySelector('[data-block-toggle]')?.removeAttribute('hidden');
    if (remembered.has(card.dataset.blockCard) && !needed(card)) setCollapsed(card, true);
  }
  remember();
  document.querySelector('[data-block-bar]')?.removeAttribute('hidden');
  form.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    // Every card, or just this one. The all-buttons leave a writer's disabled prose fields alone:
    // those cards are not on the screen, and "expand all" would have no way to show them.
    const all = target.closest('[data-block-all]');
    if (all) {
      for (const card of allCards())
        if (!card.closest('fieldset')?.disabled)
          setCollapsed(card, all.getAttribute('data-block-all') === 'collapse');
      remember();
      return;
    }
    const head = target.closest('.ui-block-card-head');
    if (!head) return;
    const toggle = head.querySelector('[data-block-toggle]');
    const isToggle = !!target.closest('[data-block-toggle]');
    // Empty space in the head does the same; its controls do what they say. Selecting the words to
    // copy them is no click on empty space either.
    if (!isToggle) {
      if (target.closest('a, button, summary, details, input, select, textarea, label')) return;
      if (getSelection()?.toString()) return;
    }
    const card = head.closest('[data-block-card]');
    setCollapsed(card, !('collapsed' in card.dataset));
    remember();
    toggle?.focus({ preventScroll: true });
  });
  // The live preview and a same-page link arrive by hash; `reveal` handles a click.
  window.addEventListener('hashchange', () => {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) expandAround(target);
  });
  // A fold opened from anywhere (a restored session, the live preview) belongs in view.
  form.addEventListener(
    'toggle',
    (event) => {
      const fold = event.target;
      if (fold instanceof HTMLDetailsElement && fold.open && fold.matches('.ui-block-card-fold'))
        expandAround(fold);
    },
    true
  );

  // One menu at a time, closed by a click elsewhere: it lies over the content.
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const inside = target?.closest('details.ui-block-card-more');
    for (const menu of form.querySelectorAll('details.ui-block-card-more[open]'))
      if (menu !== inside) menu.open = false;
  });

  /** Opens every closed fold around an element, so it can be shown and focused. */
  const reveal = (element) => {
    expandAround(element);
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

  // "Insert a block below" is a link into the chooser of the next place, which a fragment opens
  // without JavaScript; `data-insert-below` names the chooser itself. The writer shows no chooser
  // before prose (it is one text there), so that one comes to the card it is opened from;
  // `before:<id>` still says where the block lands.
  form.addEventListener('click', (event) => {
    const link = event.target instanceof Element && event.target.closest('a[data-insert-below]');
    const target = link && document.getElementById(link.dataset.insertBelow);
    if (!target) return;
    event.preventDefault();
    const host = link.closest('.editor-card');
    if (target.hidden && host) {
      host.append(target);
      target.hidden = false;
    }
    link.closest('details').open = false;
    reveal(target);
    target.scrollIntoView({ block: 'nearest' });
    const control = target.matches('details')
      ? target.querySelector(':scope > summary')
      : [...target.querySelectorAll('input, button')].find(shown);
    control?.focus({ preventScroll: true });
  });

  /** After a round trip: focus the control the action belongs to (brief § A6). */
  const land = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id && document.getElementById(id);
    if (!target) return;
    // A block lands at rest: open what is around it, not its own fold. Moved, it may stay collapsed.
    if (target.parentElement && !landingMoved) reveal(target.parentElement);
    if (id === 'block-new') {
      // Dropped images have their picture: what they still need is their alt text.
      const alt =
        dropped &&
        target.querySelector('[data-block-alt] textarea, [data-alt-of] :is(input, textarea)');
      if (alt) reveal(alt);
      (alt || target.querySelector('input:not([type="hidden"]), select, textarea'))?.focus();
      return;
    }
    if (id === 'blocks' && target instanceof HTMLElement) {
      target.tabIndex = -1;
      target.focus();
      return;
    }
    // A type without fields is its own card and target; it has only its actions to land on.
    if (!target.matches('details.ui-block-card-fold, [data-block-card]')) return;
    const card = target.closest('[data-block-card]');
    const summary = landingMoved
      ? card?.querySelector('details.ui-block-card-more > summary')
      : target.querySelector(':scope > summary');
    // The browser found no box to scroll to if the moved block stays collapsed.
    if (landingMoved && card && 'collapsed' in card.dataset)
      card.scrollIntoView({ block: 'start' });
    summary?.focus({ preventScroll: true });
  };
  land();

  // A refused save comes back without a hash: the words are in the summary and at the field, and
  // the block they concern is open (#159). The first refused field that can take focus gets it; a
  // text kept in a hidden field for its editor falls back to that block's summary.
  if (state?.hasAttribute('data-refused') && !location.hash) {
    const refused = [...form.querySelectorAll('[data-block-card] [aria-invalid="true"]')];
    const field = refused.find(shown);
    const fold = refused[0]?.closest('details.ui-block-card-fold');
    (field ?? fold?.querySelector(':scope > summary'))?.focus();
  }

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

  // The hero's description line, live (#158). The same order as `lib/admin/hero-alt/hero-alt.ts`,
  // which the server renders with; every state's words are in the markup, so this only chooses.
  for (const heroAlt of form.querySelectorAll('details[data-hero-alt]')) {
    const heroText = heroAlt.querySelector('textarea');
    if (!(heroAlt instanceof HTMLDetailsElement) || !(heroText instanceof HTMLTextAreaElement))
      continue;
    const { savedImage, savedText } = heroAlt.dataset;
    const others = Number(heroAlt.dataset.others);
    const storedOthers = Number(heroAlt.dataset.storedOthers);
    const { imageName, clearName } = heroAlt.dataset;
    const box = heroAlt.querySelector(`input[name="${CSS.escape(clearName)}"]`);
    const chosenImage = () =>
      [...form.querySelectorAll(`input[type="radio"][name="${CSS.escape(imageName)}"]`)].find(
        (i) => i.checked
      )?.value ?? '';
    const part = (selector) => heroAlt.querySelector(selector);
    const sync = () => {
      const image = chosenImage();
      const replaced = !!image && image !== savedImage;
      const text = heroText.value.trim();
      const flagged = 'flagged' in heroAlt.dataset;
      const kept = replaced ? 0 : storedOthers;
      const clearing = box instanceof HTMLInputElement && box.checked;
      const [state, tone] = clearing
        ? ['cleared', 'neutral']
        : text
          ? ['described', flagged ? 'err' : 'ok']
          : flagged
            ? ['missing', 'err']
            : replaced
              ? ['fresh', 'info']
              : kept
                ? ['missing', 'warn']
                : ['decorative', 'neutral'];
      heroAlt.hidden = !image;
      heroAlt.dataset.tone = tone;
      for (const words of heroAlt.querySelectorAll('[data-hero-alt-state]'))
        words.hidden = words.dataset.heroAltState !== state;
      part('[data-hero-alt-quote]').textContent = heroText.value;
      part('[data-hero-alt-extra="kept"]').hidden =
        state !== 'described' || replaced || others === storedOthers;
      part('[data-hero-alt-extra="replaced"]').hidden =
        state !== 'described' || !replaced || !others;
      const edit = state === 'described' || state === 'cleared';
      part('[data-hero-alt-action="edit"]').hidden = !edit;
      part('[data-hero-alt-action="describe"]').hidden = edit;
      part('[data-hero-alt-empty="decorative"]').hidden = kept > 0;
      for (const standing of heroAlt.querySelectorAll(
        '[data-hero-alt-empty="open"], [data-hero-alt-others]'
      ))
        standing.hidden = kept === 0;
    };
    /** What was typed answered a refusal: the error goes with it. */
    const settle = () => {
      if (!('flagged' in heroAlt.dataset)) return;
      delete heroAlt.dataset.flagged;
      heroText.removeAttribute('aria-invalid');
      heroText.closest('.ui-field')?.classList.remove('invalid');
      heroText.closest('.ui-field')?.querySelector('.ui-error')?.remove();
      heroText.setAttribute(
        'aria-describedby',
        heroText.getAttribute('aria-describedby')?.replace(`${heroText.id}-error`, '').trim() ?? ''
      );
    };
    heroText.addEventListener('input', () => {
      settle();
      sync();
    });
    box?.addEventListener('change', () => {
      settle();
      sync();
    });
    form.addEventListener('change', (event) => {
      const radio = event.target;
      if (!(radio instanceof HTMLInputElement) || radio.name !== imageName) return;
      // A stored description described the old picture (the server keeps only text typed over it);
      // back on the stored image it applies again. What someone typed stays in both directions.
      const image = chosenImage();
      if ('blockAlt' in heroAlt.dataset) {
        if (image && image !== savedImage && box instanceof HTMLInputElement) box.checked = false;
        sync();
        return;
      }
      if (image && image !== savedImage) {
        if (heroText.value === savedText) heroText.value = '';
        if (box instanceof HTMLInputElement) box.checked = false;
      } else if (image && !heroText.value.trim()) heroText.value = savedText ?? '';
      sync();
    });
    // Opening is a wish to write: the field, as a click on a block's words lands in its field.
    heroAlt.querySelector(':scope > summary').addEventListener('click', () => {
      if (!heroAlt.open) requestAnimationFrame(() => heroText.focus({ preventScroll: true }));
    });
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
