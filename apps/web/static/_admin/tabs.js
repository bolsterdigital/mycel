// The sections of a Tabs component as real tabs (#66 PR 3, brief edit-screen § 9a). The server
// renders every section below the other with its heading and a hidden tablist; this script shows
// the tablist, makes each section a tabpanel and shows one at a time, with the arrow keys, Home
// and End of the ARIA tabs pattern (automatic activation: a tab shows its panel on focus). The
// chosen tab is the URL's hash, `#<tabs id>-<section>`, so a reload or a shared link opens it and
// nothing is stored. A hash that points into another panel (an issue link of a refused save, a
// `#block-<id>` redirect) opens that panel first. The fields stay in the one form, so switching
// loses nothing. A panel whose only content is one fold opens it: the tab already is the
// disclosure. Rejected: localStorage per item (state a reader cannot see in the URL) and
// manual activation (one more key press per tab for a panel that costs nothing to show).
for (const root of document.querySelectorAll('.ui-tabs')) {
  const list = root.querySelector(':scope > [role="tablist"]');
  const tabs = [...(list?.querySelectorAll('[role="tab"]') ?? [])];
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
  if (!list || !tabs.length || panels.some((panel) => !panel)) continue;

  const select = (index, { focus = false, remember = true } = {}) => {
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    });
    if (focus) tabs[index].focus();
    if (remember) history.replaceState(history.state, '', `#${panels[index].id}`);
  };
  /** The panel the hash points at or into, if any. */
  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id && document.getElementById(id);
    return target ? panels.findIndex((panel) => panel.contains(target)) : -1;
  };

  for (const panel of panels) {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `${panel.id.replace(`${root.id}-`, `${root.id}-tab-`)}`);
    panel.tabIndex = 0;
    const folds = panel.querySelectorAll(':scope > details.ui-fold');
    if (folds.length === 1 && panel.children.length === 2) folds[0].open = true;
  }
  list.hidden = false;
  root.dataset.tabs = '';
  /** Shows the panel the hash points into and brings the target in view, as the browser would. */
  const follow = () => {
    const index = fromHash();
    if (index < 0) return false;
    select(index, { remember: false });
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target !== panels[index]) target?.scrollIntoView({ block: 'start' });
    return true;
  };
  // A hash inside a panel (a field, a block) keeps its own target: the URL is not rewritten.
  if (!follow()) select(0, { remember: false });

  list.addEventListener('click', (event) => {
    const tab = event.target instanceof Element && event.target.closest('[role="tab"]');
    if (tab) select(tabs.indexOf(tab));
  });
  list.addEventListener('keydown', (event) => {
    const at = tabs.indexOf(document.activeElement);
    if (at < 0) return;
    const last = tabs.length - 1;
    const to = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    select(to, { focus: true });
  });
  window.addEventListener('hashchange', follow);
}
