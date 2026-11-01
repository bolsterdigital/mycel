// Progressive enhancement for the status page (brief admin-operations-screens § 9): every minute,
// while the tab is visible and nobody is reading a fold or filling a form in it, fetch the page
// again and swap the region `[data-status-live]` for the fresh one. Without this script the page
// has a "Refresh" link and nothing else changes. A refresh that fails or finds access gone never
// leaves the old verdict standing as if it were current: the heading becomes "Status unknown"
// (copy from the markup, `data-unknown`), the summary takes the `unknown` tone and the note that
// says why appears. A changed verdict is read out through one polite live region; nothing else
// interrupts. Rejected: a server-sent stream (a long-lived connection per open admin tab for a
// page that changes a few times a day) and a JSON endpoint (a second read path beside the page).
const INTERVAL_MS = 60_000;

const live = document.querySelector('[data-status-live]');
if (live) {
  const announce = document.createElement('p');
  announce.className = 'ui-visually-hidden';
  announce.setAttribute('aria-live', 'polite');
  live.before(announce);

  const note = (name, on) => {
    const el = live.querySelector(`[data-status-note="${name}"]`);
    if (el) el.hidden = !on;
  };
  const title = () => live.querySelector('.ui-status-summary-title');
  note('auto', true);

  const unknown = (why) => {
    const summary = live.querySelector('.ui-status-summary');
    summary?.classList.remove('ok', 'attention');
    summary?.classList.add('unknown');
    const heading = title();
    if (heading && live.dataset.unknown) heading.textContent = live.dataset.unknown;
    note('failed', why === 'failed');
    note('forbidden', why === 'forbidden');
  };

  const busy = () =>
    document.hidden ||
    live.querySelector('details[open]') !== null ||
    live.contains(document.activeElement?.closest('form') ?? null);

  // This origin's own page, parsed into a document that runs nothing (Trusted Types, vite.config.ts).
  const policy = window.trustedTypes?.createPolicy('mycel-status-html', { createHTML: (s) => s });
  const inert = (html) => policy?.createHTML(html) ?? html;

  const refresh = async () => {
    if (busy()) return;
    live.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(location.pathname, {
        credentials: 'same-origin',
        headers: { accept: 'text/html' },
      });
      if (res.redirected || res.status === 401 || res.status === 403) return unknown('forbidden');
      if (!res.ok) return unknown('failed');
      const fresh = new DOMParser()
        .parseFromString(inert(await res.text()), 'text/html')
        .querySelector('[data-status-live]');
      if (!fresh) return unknown('failed');
      if (busy()) return;
      const before = title()?.textContent;
      live.replaceChildren(...fresh.childNodes);
      note('auto', true);
      const after = title()?.textContent;
      if (after && after !== before) announce.textContent = after;
    } catch {
      unknown('failed');
    } finally {
      live.removeAttribute('aria-busy');
    }
  };

  setInterval(refresh, INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}
