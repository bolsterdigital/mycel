// The parent verifies both origin and frame source before acting. The block list in the parent
// remains the keyboard route; a preview click is only a pointer shortcut.
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const block = event.target.closest('[data-block-id]');
  const id = block?.getAttribute('data-block-id');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return;
  event.preventDefault();
  event.stopPropagation();
  window.parent.postMessage({ type: 'mycel:block-select', blockId: id }, window.location.origin);
});
