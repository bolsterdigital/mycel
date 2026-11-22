// A full campaign card's long text, shortened (ADR 038 amendment of 2026-11-22, item 2; MY-276):
// the server renders the whole text open, with the words of the button in `data-more` and
// `data-less` (`CampaignLayout.svelte`), and that is the whole feature without this module. With
// it, a text taller than its limit gets the class `campaign-text-clamped` (campaign.css: a height
// and a fade, no `style` attribute under the CSP) and a real button after it, `aria-expanded`
// and `aria-controls`. "Read more" shows everything and keeps the focus on the button; "read
// less" shortens it again and scrolls back to the start of the text, the focus still on the
// button, which then stands right under the shortened text. A focus that lands inside the hidden
// part (a link, by Tab) expands the text first, so it never sits out of sight. A text that fits
// its limit, now or after a resize, gets no class and no button.
//
// A plain file in `static/`, served from the site's own origin under `script-src 'self'`, like
// `_image/lightbox.js`. Rejected: `<details>` (closed by default, the text out of sight, which the
// owner found unfinished) and `max-height` with a script that hides the rest without it (then the
// text is unreachable without JavaScript).

const CLAMPED = 'campaign-text-clamped';

function enhance(text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button secondary campaign-more';
  button.setAttribute('aria-controls', text.id);
  button.hidden = true;
  text.after(button);

  let expanded = false;

  const show = (open) => {
    expanded = open;
    text.classList.toggle(CLAMPED, !open);
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? text.dataset.less : text.dataset.more;
  };

  // With the class on, the limit is its computed `max-block-size` in px (it follows the text
  // size) and `scrollHeight` is still the whole text's height.
  const measure = () => {
    text.classList.add(CLAMPED);
    const long = text.scrollHeight > parseFloat(getComputedStyle(text).maxBlockSize) + 1;
    text.classList.toggle(CLAMPED, long);
    button.hidden = !long;
    if (long) show(false);
  };

  button.addEventListener('click', () => {
    show(!expanded);
    if (!expanded) text.scrollIntoView({ block: 'start' });
  });
  text.addEventListener('focusin', () => {
    if (!expanded && !button.hidden) show(true);
  });
  measure();
  new ResizeObserver(() => {
    if (!expanded) measure();
  }).observe(text);
}

for (const text of document.querySelectorAll('.campaign-text[data-more]')) enhance(text);
