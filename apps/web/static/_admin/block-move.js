// A pointer or keyboard gesture chooses an anchor; the existing move form action saves all input
// before moving by stable id. Rejected: DOM reordering (would disagree with the article writer),
// HTML drag/drop (touch support and file drops belong to block-drop.js), and an optimistic save.
const form = document.getElementById('item-edit');
if (form instanceof HTMLFormElement) {
  const status = form.querySelector('[data-block-move-status]');
  let gesture = null;
  const idOf = (element) =>
    element.dataset.blockId ?? element.dataset.blockCard?.replace(/^(?:native-)?block-/, '');
  // The writer portals native cards inside its top-level nodes; prose has the same stable id.
  // Its hidden native cards must not become duplicate targets. Never inspect paragraph offsets.
  const targets = () =>
    [...form.querySelectorAll('[data-block-card], .ProseMirror > [data-block-id]')]
      .filter(
        (element) =>
          element.getClientRects().length &&
          (!element.closest('.editor-card') || element.matches('.editor-card'))
      )
      .filter((element) => idOf(element));
  const clear = () => {
    form
      .querySelectorAll('[data-move-place]')
      .forEach((node) => node.removeAttribute('data-move-place'));
  };
  const cancel = () => {
    if (!gesture) return;
    const grip = gesture.grip;
    gesture = null;
    clear();
    if (status) status.textContent = status.dataset.cancelled;
    grip.focus({ preventScroll: true });
  };
  const choose = (target, side) => {
    if (!gesture || !target || idOf(target) === gesture.id) return;
    clear();
    gesture.target = target;
    gesture.side = side;
    target.dataset.movePlace = side;
    const name =
      target.querySelector('.ui-block-card-name, .ui-block-card-type')?.textContent ||
      target.textContent?.trim().slice(0, 70);
    if (status) status.textContent = `${status.dataset[side]} ${name}`;
  };
  const start = (grip, pointer = null) => {
    cancel();
    gesture = {
      grip,
      id: idOf(grip.closest('[data-block-card]')),
      pointer,
      target: null,
      side: null,
      moved: false,
    };
    if (status) status.textContent = status.dataset.picked;
  };
  const finish = () => {
    if (!gesture) return;
    const { grip, id, target, side } = gesture;
    const action = grip.closest('[data-block-card]').querySelector('button[name="move"]');
    gesture = null;
    clear();
    if (!target || !action) return;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.hidden = true;
    submit.name = 'move';
    submit.value = `${id}:${side}:${idOf(target)}`;
    submit.formAction = action.formAction;
    form.append(submit);
    form.requestSubmit(submit);
    submit.remove();
  };
  for (const grip of form.querySelectorAll('[data-block-move]')) {
    grip.hidden = false;
    grip.disabled = false;
    grip.title = status?.dataset.picked ?? '';
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      grip.focus({ preventScroll: true });
      start(grip, event.pointerId);
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener('pointermove', (event) => {
      if (!gesture || gesture.pointer !== event.pointerId) return;
      if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6)
        return;
      gesture.moved = true;
      const candidates = targets().filter((target) => idOf(target) !== gesture.id);
      const target =
        candidates.find((node) => event.clientY < node.getBoundingClientRect().bottom) ??
        candidates.at(-1);
      if (!target) return;
      const box = target.getBoundingClientRect();
      choose(target, event.clientY < box.top + box.height / 2 ? 'before' : 'after');
      gesture.moved = true;
      if (event.clientY < 80) window.scrollBy(0, -24);
      if (event.clientY > innerHeight - 80) window.scrollBy(0, 24);
    });
    grip.addEventListener('pointerup', (event) => {
      if (gesture?.pointer !== event.pointerId) return;
      if (gesture.moved) finish();
      else cancel();
    });
    grip.addEventListener('pointercancel', cancel);
    grip.addEventListener('lostpointercapture', () => {
      if (gesture?.pointer !== null) cancel();
    });
    grip.addEventListener('keydown', (event) => {
      if (![' ', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') return cancel();
      if (event.key === ' ' || event.key === 'Enter') {
        if (gesture?.grip === grip) finish();
        else start(grip);
        return;
      }
      if (gesture?.grip !== grip || gesture.pointer !== null) return;
      const all = targets();
      const candidates = all.filter((target) => idOf(target) !== gesture.id);
      const current = gesture.target ? candidates.indexOf(gesture.target) : -1;
      const origin = all.findIndex((target) => idOf(target) === gesture.id);
      const down = event.key === 'ArrowDown' || event.key === 'End';
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? candidates.length - 1
            : current < 0
              ? Math.max(0, Math.min(candidates.length - 1, down ? origin : origin - 1))
              : Math.max(0, Math.min(candidates.length - 1, current + (down ? 1 : -1)));
      choose(candidates[index], down ? 'after' : 'before');
      candidates[index]?.scrollIntoView({ block: 'nearest' });
    });
  }
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && gesture) {
        event.preventDefault();
        cancel();
      }
    },
    true
  );
  form.dataset.blockMove = '';
}
