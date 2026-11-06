// Progressive enhancement for the notifications page (brief § 5): opening the page is
// reading it, so the page posts its own "Mark as read" form once shown, in the background. The
// rows keep saying "New" for this visit; on success the form goes and the bell in the shell drops
// its count, so the next page is quiet. A failed post changes nothing on screen: the button stays,
// and the member can still press it. Without this script the button is the only way.
// Rejected: submitting the form as a navigation (the page would reload and lose its "New" marks
// at the moment they are read) and a timer before posting (an open page is a read page).
const form = document.querySelector('form[data-attention-seen]');
if (form instanceof HTMLFormElement) {
  fetch(form.action, {
    method: 'POST',
    body: new FormData(form),
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'x-sveltekit-action': 'true' },
  })
    .then(async (res) => {
      if (!res.ok) return;
      const result = await res.json();
      if (result?.type !== 'success') return;
      form.remove();
      const bell = document.querySelector('[data-attention-bell]');
      bell?.removeAttribute('aria-label');
      bell?.querySelector('.ui-attention-count')?.remove();
    })
    .catch(() => {
      // Offline or refused: the button is still there.
    });
}
