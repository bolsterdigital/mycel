// Unsaved editor input survives an expired session (brief admin-entry, recovery contract of
// 2026-10-31). A post without a session never reaches the form action: the admin answers it with
// the login page, and what was typed would be gone. With JavaScript, this module keeps it for one
// trip through the login, in this tab only:
// - on the edit screen, a submit while the form has unsaved changes (`data-has-unsaved`, set by
//   edit-screen.js) writes what is being sent to sessionStorage, under the site, the operator,
//   the item and the content locale, as "sent";
// - on the login page, a "sent" record for the page that sent us there, written in the last few
//   minutes, becomes "expired": the post did not arrive;
// - back on the edit screen, an "expired" record is posted to the screen's `recover` action,
//   which saves nothing and shows the page as after a refused save (what was typed, the notice
//   that it was put back, a conflict when someone saved in between); any other record of this
//   item is a round trip that did arrive and goes;
// - logging out, or the edit screen of another operator in this tab, removes the records.
// No files (a file input cannot be filled in again) and no choice of action. The server decides
// what the input means: `recover` reads it like a save would and checks the revision it was
// based on, so a stale record is a conflict, never a silent overwrite.
// Rejected: localStorage (it outlives the tab and is shared by every tab and every operator of
// the browser), keeping every keystroke (an unbounded draft store, brief edit-screen § 5 has no
// autosave) and putting the values back with a script (the rich text editors start from what
// the server rendered; the refused-save path already renders typed values everywhere).

const PREFIX = 'mycel.restore:';
/** A record older than this is not put back. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** The login page only counts a submit this recent as the one that sent it there. */
const SENT_WINDOW_MS = 10 * 60 * 1000;
/** Controls that choose an action rather than carry the document (as in edit-screen.js). */
const IGNORED = /^(insertType\.|at\.|patternId$|insert$|restore$|remove$)/;

const store = (() => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
})();

const records = () => {
  const out = [];
  if (!store) return out;
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      out.push({ key, record: JSON.parse(store.getItem(key) ?? '') });
    } catch {
      out.push({ key, record: null });
    }
  }
  return out;
};
const drop = (key) => {
  try {
    store?.removeItem(key);
  } catch {
    // Nothing to keep then.
  }
};

const form = document.getElementById('item-edit');
const login = document.querySelector('[data-restore-return]');

if (document.querySelector('[data-restore-clear]')) {
  for (const { key } of records()) drop(key);
} else if (login) {
  const back = new URL(login.getAttribute('data-restore-return') ?? '/', location.origin).pathname;
  for (const { key, record } of records()) {
    if (record?.state !== 'sent' || record.path !== back) continue;
    if (Date.now() - record.at > SENT_WINDOW_MS) continue;
    try {
      store?.setItem(key, JSON.stringify({ ...record, state: 'expired' }));
    } catch {
      drop(key);
    }
  }
} else if (form instanceof HTMLFormElement && form.dataset.restore) {
  const key = PREFIX + form.dataset.restore;
  const operator = form.dataset.restoreOperator;
  let mine = null;
  for (const { key: other, record } of records()) {
    // Someone else logged in in this tab, or the record is too old: it goes.
    if (!record || record.operator !== operator || Date.now() - record.at > MAX_AGE_MS) drop(other);
    else if (other === key) mine = record;
  }
  if (mine) drop(key);
  if (mine?.state === 'expired' && Array.isArray(mine.values)) recover(mine);

  let sending = false;
  form.addEventListener('submit', () => {
    sending = form.hasAttribute('data-has-unsaved');
  });
  // `formdata` fires after every submit listener (the article writer fills its fields in one),
  // with exactly what the browser sends.
  form.addEventListener('formdata', (event) => {
    if (!sending) return;
    sending = false;
    const values = [];
    for (const [name, value] of event.formData)
      if (typeof value === 'string' && !IGNORED.test(name)) values.push([name, value]);
    try {
      store?.setItem(
        key,
        JSON.stringify({ state: 'sent', operator, path: location.pathname, at: Date.now(), values })
      );
    } catch {
      // Storage full or blocked: the submit goes on as before, without the safety net.
    }
  });
}

/** Posts the kept input to the screen's `recover` action, at the screen's own address. */
function recover(record) {
  const url = new URL(location.href);
  url.hash = '';
  const query = [...url.searchParams].filter(([name]) => !name.startsWith('/'));
  url.search = new URLSearchParams(query).toString();
  url.search += `${url.search ? '&' : '?'}/recover`;
  const post = document.createElement('form');
  post.method = 'post';
  post.action = url.pathname + url.search;
  post.hidden = true;
  for (const [name, value] of record.values) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    post.append(input);
  }
  document.body.append(post);
  post.submit();
}
