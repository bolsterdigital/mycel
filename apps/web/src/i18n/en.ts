// UI copy for the web front (ADR 007 rule 1): public chrome only. Domain messages (validation,
// mail) live in @mycel/core's catalogs; content (labels, consent text) lives on the documents.

export const en = {
  'error.prefix': 'Error:',
  'error.summary.title': 'There is a problem',
  'form.honeypot.label': 'Leave this field empty',
  'confirm.ok.title': 'Subscription confirmed',
  'confirm.ok.body': 'Thank you, your subscription is confirmed.',
  'confirm.already.title': 'Already confirmed',
  'confirm.already.body': 'This subscription was confirmed earlier. Nothing more to do.',
  'confirm.invalid.title': 'This link does not work',
  'confirm.invalid.body':
    'The confirmation link is invalid or has expired. Sign up again to receive a new one.',
  'thanks.back': 'Back to the page',
} as const;

export type UiKey = keyof typeof en;
