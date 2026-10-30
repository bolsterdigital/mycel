// Progressive enhancement for SettingsSection (brief #81): once a field of a form marked
// `data-unsaved` changes, its "unsaved changes" note appears, and leaving the page asks first
// until that form is submitted. Without this script the form posts the same way and nothing is
// shown. Rejected: comparing every field with its initial value (a colour picked and picked back
// still counts as a change here, which errs on the side of asking) and a custom leave dialog
// (browsers only allow their own).
const changed = new Set();

for (const form of document.querySelectorAll('form[data-unsaved]')) {
  const note = form.querySelector('[data-unsaved-note]');
  const mark = () => {
    changed.add(form);
    if (note) note.hidden = false;
  };
  form.addEventListener('input', mark);
  form.addEventListener('change', mark);
  form.addEventListener('submit', () => changed.delete(form));
}

window.addEventListener('beforeunload', (event) => {
  if (changed.size > 0) event.preventDefault();
});
