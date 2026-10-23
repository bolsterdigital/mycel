// Proof of work for public forms (ADR 010 rule 5, brief form-intake § D2.3): solves the ALTCHA
// challenge in a form's `data-proof` and puts the solution in its hidden `_proof` field. The
// public site ships no other JavaScript (`csr = false`), and the form works without this file:
// a post without a solution takes the stricter `unproven` route on the server (ADR 009).
//
// Nothing visible, nothing to operate, so no new accessibility surface. A submit before the
// solution is ready waits at most two seconds and then posts anyway; the submit button is never
// disabled. The search runs in batches whose digests run concurrently, with a yield to the event
// loop between batches, so typing stays smooth.
//
// A plain file in `static/`, served from the site's own origin, so `script-src 'self'` covers it
// without a nonce or a new CSP exception. Rejected: a Vite-built client entry, which with
// `csr = false` would need a hand-wired asset import for one dependency-free module, and a Web
// Worker, which adds a second file for a search of under a second (forms/proof.ts).

const BATCH = 1000;
const WAIT_MS = 2000;

const hex = (buffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

async function solve({ algorithm, challenge, salt, maxNumber, signature }) {
  const encoder = new TextEncoder();
  for (let start = 0; start <= maxNumber; start += BATCH) {
    const end = Math.min(start + BATCH, maxNumber + 1);
    const tries = [];
    for (let n = start; n < end; n++)
      tries.push(crypto.subtle.digest('SHA-256', encoder.encode(salt + n)).then(hex));
    const hit = (await Promise.all(tries)).indexOf(challenge);
    if (hit >= 0)
      return btoa(JSON.stringify({ algorithm, challenge, number: start + hit, salt, signature }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return '';
}

function arm(form) {
  const field = form.querySelector('input[name="_proof"]');
  if (!field) return;
  let challenge;
  try {
    challenge = JSON.parse(form.dataset.proof);
  } catch {
    return;
  }
  const solved = solve(challenge)
    .then((value) => {
      field.value = value;
    })
    .catch(() => {});

  let waited = false;
  form.addEventListener('submit', (event) => {
    if (field.value || waited) return;
    event.preventDefault();
    waited = true;
    const submitter = event.submitter;
    const timeout = new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    Promise.race([solved, timeout]).then(() => {
      if (form.requestSubmit) form.requestSubmit(submitter ?? undefined);
      else form.submit();
    });
  });
}

// Web Crypto is there in every secure context; elsewhere the form simply posts without a proof.
if (globalThis.crypto?.subtle)
  for (const form of document.querySelectorAll('form[data-proof]')) arm(form);
