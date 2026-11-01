// The admin menu's collapse button (#87): from 60rem the sidebar can shrink to a rail of icons,
// and the browser remembers it. A classic script in <head>, so the stored choice is on <html>
// before the first paint and the menu never jumps from full to rail. admin.css shows the button
// only once `data-admin-nav` is there, so without this script there is no dead control and the
// menu stays as it is; the button's two labels are both in the markup and CSS shows the one that
// fits, so nothing here writes copy. Rejected: a cookie read by the server (a request header and a
// server branch for a per-browser view preference), and a rail that switches on by itself per
// screen (Jaap 2026-10-30: only the button).
(() => {
  const KEY = 'mycel.admin.nav';
  const root = document.documentElement;
  // Already running in this document (AdminScript imports what a later mount needs).
  if (root.dataset.adminNav) return;
  let stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // Storage blocked (private mode, a policy): the button still works for this page.
  }
  root.dataset.adminNav = stored === 'rail' ? 'rail' : 'full';
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-nav-toggle]')) return;
    const next = root.dataset.adminNav === 'rail' ? 'full' : 'rail';
    root.dataset.adminNav = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // As above: the choice holds until the next page.
    }
  });
})();
