// Measure the ordinary paragraph after its font is ready. A character count cannot account for
// text zoom, line width or the typeface. Keep plain text if the initial would move later content.
const page = document.querySelector('[data-measure-initial]');
const block = page?.querySelector(':scope > .rich-text, :scope > .preview-selectable > .rich-text');
const paragraph = block?.firstElementChild;
if (page && paragraph?.matches('p') && window.ResizeObserver) {
  function measure() {
    page.removeAttribute('data-drop-cap');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const height = paragraph.getBoundingClientRect().height;
    const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
    if (!lineHeight || height / lineHeight < 2.95 || !range.toString().trim()) return;
    page.setAttribute('data-drop-cap', '');
    if (Math.abs(paragraph.getBoundingClientRect().height - height) > 1)
      page.removeAttribute('data-drop-cap');
  }
  document.fonts.ready.then(() => {
    new ResizeObserver(measure).observe(paragraph);
    document.fonts.addEventListener('loadingdone', measure);
    window.addEventListener('resize', measure);
    measure();
  });
}
