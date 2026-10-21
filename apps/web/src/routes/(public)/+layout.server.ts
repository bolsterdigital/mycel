// Public tenant pages are server-rendered HTML with no client-side JavaScript (ADR 009 rules 1
// and 4): forms post natively and the server answers with a full page. Rejected: hydrating and
// progressively enhancing with `use:enhance`; nothing on these pages needs it yet.
export const csr = false;
