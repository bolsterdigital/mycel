import type { UiKey } from './en.js';

export const nl: Partial<Record<UiKey, string>> = {
  'error.prefix': 'Fout:',
  'error.summary.title': 'Er is een probleem',
  'form.honeypot.label': 'Laat dit veld leeg',
  'confirm.ok.title': 'Inschrijving bevestigd',
  'confirm.ok.body': 'Bedankt, je inschrijving is bevestigd.',
  'confirm.already.title': 'Al bevestigd',
  'confirm.already.body': 'Deze inschrijving was al eerder bevestigd. Je hoeft niets meer te doen.',
  'confirm.invalid.title': 'Deze link werkt niet',
  'confirm.invalid.body':
    'De bevestigingslink is ongeldig of verlopen. Meld je opnieuw aan om een nieuwe te krijgen.',
  'thanks.back': 'Terug naar de pagina',
};
