// Click to load a video player (docs/reference/integrations.md § Video). The server placed a
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
    const fallback = player.querySelector('.video-link');
    const { embedSrc, embedTitle } = player.dataset;
    if (!button || !fallback || !embedSrc) continue;
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
        player.querySelector('.video-poster')?.remove();
        button.replaceWith(frame);
        frame.focus();
      },
      { once: true }
    );
    fallback.hidden = true;
    button.hidden = false;
  }
})();

// Keep the native player inline when scripting is available. The same form opens it as
// a regular page without JavaScript. No source is assigned before the authorized POST.
for (const form of document.querySelectorAll('form[data-managed-video]')) {
  form.addEventListener('submit', () => {
    if (form.target) return;
    const frame = document.createElement('iframe');
    frame.name = `mycel-video-${crypto.randomUUID()}`;
    frame.title = form.querySelector('button').getAttribute('aria-label');
    frame.className = 'managed-video-frame';
    frame.allowFullscreen = true;
    frame.allow = 'autoplay; fullscreen; picture-in-picture';
    form.target = frame.name;
    const mode = document.createElement('input');
    mode.type = 'hidden';
    mode.name = 'inline';
    mode.value = '1';
    form.append(mode);
    form.after(frame);
    // Preserve the submit through the event's default action before moving focus.
    frame.addEventListener(
      'load',
      () => {
        form.hidden = true;
        frame.focus();
        // The reader pressed play: start it, rather than showing a second play button. The frame
        // is same-origin and the click is the page's activation; a refusal leaves the controls.
        void frame.contentDocument
          ?.querySelector('video')
          ?.play()
          ?.catch(() => {});
      },
      { once: true }
    );
  });
}
