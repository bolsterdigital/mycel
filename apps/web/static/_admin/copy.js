// Progressive enhancement for KeyReveal and CopyField (brief #81): a copy button next to a value.
// `data-copy` names the element that holds the value: its text, or its value for a form control.
// The button is in the markup but hidden; it appears only where the clipboard API is available,
// so a page without this script, or a browser without the API, never shows a dead control. The
// outcome is read out through one polite live region the script adds, not by changing the label
// alone. Rejected: document.execCommand('copy'), deprecated and silent on failure.
const RESET_MS = 4000;

for (const button of document.querySelectorAll('button[data-copy]')) {
  const source = document.getElementById(button.dataset.copy);
  if (!source || !navigator.clipboard?.writeText) continue;
  const status = document.createElement('span');
  status.className = 'ui-visually-hidden';
  status.setAttribute('aria-live', 'polite');
  button.after(status);
  const label = button.textContent;
  let timer;
  button.hidden = false;
  button.addEventListener('click', async () => {
    let outcome;
    try {
      await navigator.clipboard.writeText(
        ('value' in source ? source.value : source.textContent).trim()
      );
      outcome = button.dataset.copied;
    } catch {
      outcome = button.dataset.failed;
    }
    button.textContent = outcome;
    status.textContent = outcome;
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.textContent = label;
      status.textContent = '';
    }, RESET_MS);
  });
}
