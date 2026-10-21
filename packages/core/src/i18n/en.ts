// English domain catalog: the platform default locale (ADR 007 rule 4), therefore complete.
// Other catalogs are `Partial` and fall back to this one key by key.

export const en = {
  'forms.error.required': 'This field is required.',
  'forms.error.email.invalid':
    'Enter an e-mail address in the right format, like name@example.org.',
  'forms.error.consent.required': 'Tick the box to confirm that you want to sign up.',
  'forms.error.unknown-field': 'This field is not part of the form.',
  'forms.rejected.too-fast':
    'That was very quick. Please check your details and send the form again.',
  'forms.rejected.rate-limited':
    'Too many attempts from you in a short time. Please try again later.',
  'mail.confirm.subject': 'Confirm your subscription to {tenant}',
  'mail.confirm.heading': 'Confirm your subscription',
  'mail.confirm.intro':
    'Thank you for subscribing to the newsletter of {tenant}. Use the link below to confirm. If you do not, you will not receive the newsletter.',
  'mail.confirm.button': 'Confirm subscription',
  'mail.confirm.fallback': 'Does the button not work? Copy this link into your browser:',
  'mail.confirm.ignore': 'Did not sign up yourself? Then you can ignore this e-mail.',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
