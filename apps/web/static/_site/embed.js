// Click to load a video player (docs/reference/integrations.md, #41 PR 2). The server placed a
// hidden play button only for a provider the site switched on, with the player's address on its
// wrapper (`VideoEmbed.svelte`); this file shows those buttons and, on a click, puts the player in
// the button's place and moves focus to it. Nothing reaches the provider before that click, and
// the response's CSP frames that provider's one origin and no other.
//
// A plain classic file in `static/`, like `pageview.js`: `script-src 'self'` covers it without a
// nonce, and it is on a page only when the page places an embed. It sets no HTML, so Trusted
// Types has nothing to refuse. The sandbox keeps what a player needs (its own scripts and origin,
// fullscreen, a link out to the provider) and drops the rest: no top navigation, no forms.
// Rejected: loading players when the page loads (the visitor would reach the provider unasked)
// and a thumbnail from the provider (another third-party request before the click).
(() => {
  for (const player of document.querySelectorAll('.video-player[data-embed-src]')) {
    const button = player.querySelector('button');
    const { embedSrc, embedTitle } = player.dataset;
    if (!button || !embedSrc) continue;
    button.addEventListener(
      'click',
      () => {
        const frame = document.createElement('iframe');
        frame.title = embedTitle ?? '';
        frame.allow = 'autoplay; fullscreen; picture-in-picture';
        frame.allowFullscreen = true;
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        frame.setAttribute(
          'sandbox',
          'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox'
        );
        frame.src = embedSrc;
        button.replaceWith(frame);
        frame.focus();
      },
      { once: true }
    );
    player.hidden = false;
  }
})();
