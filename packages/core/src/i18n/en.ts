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
  'forms.rejected.closed': 'This site is not taking new sign-ups at the moment.',
  'mail.confirm.subject': 'Confirm your subscription to {tenant}',
  'mail.confirm.heading': 'Confirm your subscription',
  'mail.confirm.intro':
    'Thank you for subscribing to the newsletter of {tenant}. Use the link below to confirm. If you do not, you will not receive the newsletter.',
  'mail.confirm.button': 'Confirm subscription',
  'mail.confirm.fallback': 'Does the button not work? Copy this link into your browser:',
  'mail.confirm.ignore': 'Did not sign up yourself? Then you can ignore this e-mail.',
  'theme.color.invalid': 'Enter a colour as # followed by six hexadecimal digits, like #1f4f8f.',
  'theme.value.out-of-range': 'This value is outside the allowed range.',
  'theme.value.not-allowed': 'This value is not one of the options.',
  'theme.key.unknown': 'This setting is not part of a theme.',
  'theme.contrast.too-low':
    'The contrast is too low: text, links or the focus indicator would be hard to see.',
  'patterns.long-read.name': 'Long read',
  'patterns.long-read.description': 'An article with room for a long text and a pull quote.',
  'patterns.long-read.intro': 'Start with the heart of the story in two or three sentences.',
  'patterns.long-read.body': 'Write the story here. Use subheadings to give the reader a rest.',
  'patterns.long-read.quote': 'A sentence from the story that makes the reader want to read on.',
  'patterns.long-read.quote-name': 'Name of the speaker',
  'patterns.photo-story.name': 'Photo story',
  'patterns.photo-story.description': 'A story told in photos, each with a short text.',
  'patterns.photo-story.title': 'Title of the photo story',
  'patterns.photo-story.intro': 'Introduce the story: where, when and why these photos.',
  'patterns.photo-story.between': 'Tell what this photo shows that the reader would not see.',
  'forms.error.malformed': 'This form could not be processed. Reload the page and try again.',
  'forms.error.unavailable':
    'Something went wrong on our side; your signup was not saved. Please try again later. Reference: {requestId}',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
