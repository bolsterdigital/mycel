// Dutch domain catalog. `Partial` on purpose: a missing key falls back to English instead of
// breaking a build, and a test lists what is missing.

import type { Messages } from './en.js';

export const nl: Partial<Messages> = {
  'forms.error.required': 'Dit veld is verplicht.',
  'forms.error.email.invalid': 'Vul een e-mailadres in zoals naam@voorbeeld.nl.',
  'forms.error.consent.required': 'Vink het vakje aan om te bevestigen dat je je wilt aanmelden.',
  'forms.error.unknown-field': 'Dit veld hoort niet bij het formulier.',
  'forms.rejected.too-fast':
    'Dat ging erg snel. Controleer je gegevens en verstuur het formulier opnieuw.',
  'forms.rejected.rate-limited': 'Te veel pogingen in korte tijd. Probeer het later opnieuw.',
  'mail.confirm.subject': 'Bevestig je inschrijving bij {tenant}',
  'mail.confirm.heading': 'Bevestig je inschrijving',
  'mail.confirm.intro':
    'Bedankt voor je inschrijving op de nieuwsbrief van {tenant}. Bevestig je inschrijving met de link hieronder. Doe je dat niet, dan ontvang je geen nieuwsbrief.',
  'mail.confirm.button': 'Inschrijving bevestigen',
  'mail.confirm.fallback': 'Werkt de knop niet? Kopieer deze link naar je browser:',
  'mail.confirm.ignore': 'Heb je je niet zelf ingeschreven? Dan kun je deze mail negeren.',
};
