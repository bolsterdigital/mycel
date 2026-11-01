// Dutch domain catalog. `Partial` on purpose: a missing key falls back to English instead of
// breaking a build, and a test lists what is missing.

import type { Messages } from './en.js';

export const nl: Partial<Messages> = {
  'assist.error.ai-not-entitled': 'AI-hulp is niet beschikbaar voor deze site.',
  'assist.error.ai-disabled': 'Een beheerder moet AI-hulp eerst aanzetten.',
  'assist.error.consent-required': 'Toestemming voor de ingestelde verwerker is nodig.',
  'assist.error.restricted-content': 'AI-hulp voor afgeschermde inhoud staat uit.',
  'assist.error.limit-reached': 'De limiet voor AI-hulp is bereikt. Probeer het later opnieuw.',
  'assist.error.stale': 'De bron is gewijzigd. Vraag een nieuwe suggestie aan.',
  'assist.error.not-ready': 'Deze suggestie is niet meer beschikbaar.',
  'assist.error.unavailable': 'Er is geen AI-verwerker beschikbaar.',
  'assist.error.locale': 'Deze taal hoort niet bij het item.',
  'assist.error.image': 'Kies een afbeelding die niet decoratief is.',
  'forms.error.required': 'Dit veld is verplicht.',
  'forms.error.email.invalid': 'Vul een e-mailadres in zoals naam@voorbeeld.nl.',
  'forms.error.consent.required': 'Vink het vakje aan om te bevestigen dat je je wilt aanmelden.',
  'forms.error.unknown-field': 'Dit veld hoort niet bij het formulier.',
  'forms.rejected.too-fast':
    'Dat ging erg snel. Controleer je gegevens en verstuur het formulier opnieuw.',
  'forms.rejected.closed': 'Deze site neemt op dit moment geen nieuwe inschrijvingen aan.',
  'forms.rejected.rate-limited': 'Te veel pogingen in korte tijd. Probeer het later opnieuw.',
  'mail.confirm.subject': 'Bevestig je inschrijving bij {tenant}',
  'mail.confirm.heading': 'Bevestig je inschrijving',
  'mail.confirm.intro':
    'Bedankt voor je inschrijving op de nieuwsbrief van {tenant}. Bevestig je inschrijving met de link hieronder. Doe je dat niet, dan ontvang je geen nieuwsbrief.',
  'mail.confirm.button': 'Inschrijving bevestigen',
  'mail.confirm.fallback': 'Werkt de knop niet? Kopieer deze link naar je browser:',
  'mail.confirm.ignore': 'Heb je je niet zelf ingeschreven? Dan kun je deze mail negeren.',
  'theme.color.invalid': 'Vul een kleur in als # met zes hexadecimale tekens, zoals #1f4f8f.',
  'theme.value.out-of-range': 'Deze waarde valt buiten het toegestane bereik.',
  'theme.value.not-allowed': 'Deze waarde is geen van de keuzes.',
  'theme.key.unknown': 'Deze instelling hoort niet bij een thema.',
  'theme.contrast.too-low':
    'Het contrast is te laag: tekst, links of de focusmarkering zijn dan slecht te zien.',
  'patterns.long-read.name': 'Longread',
  'patterns.long-read.description':
    'Een artikel met ruimte voor een lange tekst en een uitgelicht citaat.',
  'patterns.long-read.intro': 'Begin met de kern van het verhaal in twee of drie zinnen.',
  'patterns.long-read.body':
    'Schrijf hier het verhaal. Gebruik tussenkoppen om de lezer rust te geven.',
  'patterns.long-read.quote': 'Een zin uit het verhaal die de lezer verder laat lezen.',
  'patterns.long-read.quote-name': 'Naam van de spreker',
  'patterns.photo-story.name': 'Fotoverhaal',
  'patterns.photo-story.description': 'Een verhaal in foto’s, elk met een korte tekst.',
  'patterns.photo-story.intro': 'Leid het verhaal in: waar, wanneer en waarom deze foto’s.',
  'patterns.photo-story.between': 'Vertel wat deze foto laat zien dat de lezer anders niet ziet.',
  'forms.error.malformed':
    'Dit formulier kon niet worden verwerkt. Laad de pagina opnieuw en probeer het nog eens.',
  'forms.error.unavailable':
    'Er ging aan onze kant iets mis; je aanmelding is niet opgeslagen. Probeer het later opnieuw. Kenmerk: {requestId}',
};
