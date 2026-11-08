// Selection is page-local. Native forms remain complete without this optional counter.
const form = document.querySelector('form[data-bulk-form]');
if (form && !form.dataset.enhanced) {
  form.dataset.enhanced = 'true';
  const all = form.querySelector('[name=all]');
  const rows = [...document.querySelectorAll(`[form="${form.id}"][name=selected]`)];
  const count = form.querySelector('[data-bulk-count]');
  const update = () => {
    count.textContent = count.dataset.template.replace(
      '{n}',
      String(all.checked ? rows.length : rows.filter((r) => r.checked).length)
    );
  };
  all.addEventListener('change', () => {
    rows.forEach((r) => {
      r.checked = all.checked;
    });
    update();
  });
  rows.forEach((r) =>
    r.addEventListener('change', () => {
      all.checked = false;
      update();
    })
  );
  update();
}
