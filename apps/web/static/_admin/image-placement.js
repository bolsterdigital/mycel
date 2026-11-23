// Enhance native crop fields with a live view and optional dragging. The form remains the
// source of truth: it also works by saving the draft with JavaScript disabled.
const panelSelector = '[data-image-placement]';
const slotSelector = '[data-placement-slot]';
const slots = ['framing', 'narrow', 'wide'];

function frame(panel, slot) {
  return panel.querySelector(`[data-placement-slot="${slot}"]`);
}

function read(panel, slot) {
  if (panel.querySelector('[data-placement-reset]').checked) return { mode: 'inherit' };
  const group = frame(panel, slot);
  return {
    mode: group.querySelector('[data-placement-mode]:checked').value,
    x: group.querySelector('[data-placement-axis="x"]'),
    y: group.querySelector('[data-placement-axis="y"]'),
  };
}

function sync(panel) {
  const form = panel.closest('form');
  if (!form) return;
  const bound = panel.querySelector('[data-placement-media]').value;
  const picker = form.elements.namedItem(panel.dataset.picker);
  let selected = picker?.value;
  if (panel.dataset.picker === 'featuredImageId' && !selected)
    selected = form.elements.namedItem('heroImageId')?.value || panel.dataset.fallback || '';
  const replaced = selected !== bound && selected !== undefined;
  panel.querySelector('[data-placement-fields]').hidden = replaced;
  panel.querySelector('[data-placement-source]').hidden = replaced;
  panel.querySelector('[data-placement-replaced]').hidden = !replaced;
  if (replaced) return;

  const layout = form.elements.namedItem('headerLayout')?.value;
  if (panel.dataset.picker === 'heroImageId' && layout) panel.dataset.layout = layout;
  const general = read(panel, 'framing');
  for (const picture of panel.querySelectorAll('[data-frame-preview] img')) {
    const size = picture.closest('[data-frame-preview]').dataset.framePreview;
    const active = read(panel, size);
    const mode = active.mode === 'inherit' ? general.mode : active.mode;
    picture.toggleAttribute(
      'data-draggable',
      mode === 'manual' && panel.dataset.layout !== 'standard'
    );
    for (const slot of slots) {
      const suffix = slot === 'framing' ? '' : `-${slot}`;
      const fields = read(panel, slot);
      const inheritedAuto = slot === 'framing' && panel.dataset.focal === 'auto';
      const fit = `data-frame-fit${suffix}`;
      if (fields.mode === 'inherit' && !inheritedAuto) picture.removeAttribute(fit);
      else picture.setAttribute(fit, fields.mode === 'manual' ? 'cover' : 'contain');
      for (const axis of ['x', 'y']) {
        const attribute = `data-frame-${axis}${suffix}`;
        if (fields.mode === 'manual') {
          const value = Math.min(100, Math.max(0, Math.round(fields[axis].valueAsNumber || 0)));
          picture.setAttribute(attribute, String(value).padStart(2, '0'));
        } else picture.removeAttribute(attribute);
      }
    }
  }
  panel.dataset.dragReady = '';
}

function syncForm(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const form = target.closest('form');
  const panel = target.closest(panelSelector);
  if (panel) {
    if (target.closest(slotSelector)) panel.querySelector('[data-placement-reset]').checked = false;
    sync(panel);
    return;
  }
  if (
    target.name === 'heroImageId' ||
    target.name === 'headerLayout' ||
    target.name === 'featuredImageId' ||
    target.name === 'imageId'
  )
    form?.querySelectorAll(panelSelector).forEach(sync);
}

let drag;
document.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0 || !(event.target instanceof HTMLImageElement)) return;
  const img = event.target;
  if (!img.hasAttribute('data-draggable') || !img.naturalWidth) return;
  const panel = img.closest(panelSelector);
  const size = img.closest('[data-frame-preview]').dataset.framePreview;
  const override = read(panel, size);
  const { x, y } = override.mode === 'manual' ? override : read(panel, 'framing');
  const scale = Math.max(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight);
  drag = {
    img,
    panel,
    x,
    y,
    pointer: event.pointerId,
    left: event.clientX,
    top: event.clientY,
    startX: x.valueAsNumber || 0,
    startY: y.valueAsNumber || 0,
    excessX: img.naturalWidth * scale - img.clientWidth,
    excessY: img.naturalHeight * scale - img.clientHeight,
  };
  img.setPointerCapture(event.pointerId);
});

document.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointer !== event.pointerId) return;
  const { x, y, panel, left, top, startX, startY, excessX, excessY } = drag;
  const move = (input, start, delta, excess) => {
    if (excess >= 1)
      input.value = String(Math.round(Math.min(100, Math.max(0, start - (delta / excess) * 100))));
  };
  move(x, startX, event.clientX - left, excessX);
  move(y, startY, event.clientY - top, excessY);
  sync(panel);
  // The existing draft preview and dirty-state tracking also listen for form input.
  x.dispatchEvent(new Event('input', { bubbles: true }));
});

document.addEventListener('lostpointercapture', (event) => {
  if (drag?.pointer === event.pointerId) drag = undefined;
});
document.addEventListener('change', syncForm);
document.addEventListener('input', syncForm);
document.addEventListener(
  'toggle',
  (event) => {
    if (event.target instanceof HTMLDetailsElement && event.target.matches(panelSelector))
      sync(event.target);
  },
  true
);
document.querySelectorAll(panelSelector).forEach(sync);
