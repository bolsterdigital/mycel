// De site-import (MY-257 PR 3); zie en/import.ts.

import type { UiKey } from '../en.js';

export const imports: Partial<Record<UiKey, string>> = {
  'admin.nav.import': 'Importeren',
  'admin.manage.hint.import': 'Een WordPress-site overhalen uit zijn exportbestand.',
  'admin.import.title': 'Importeren',
  'admin.import.upload.title': 'Een WordPress-site importeren',
  'admin.import.intro':
    'Upload de export van een WordPress- of Dreamkit-site. Je ziet eerst wat er meekomt en wat niet; er wordt pas iets geïmporteerd als je het start.',
  'admin.import.intro.info':
    'In WordPress: Gereedschap → Exporteren → Alle inhoud. Het bestand mag tot 25 MB zijn. Beelden worden van de site zelf gedownload, dus die moet online staan. Het geüploade bestand wordt verwijderd zodra de import gedraaid heeft.',
  'admin.import.field.file': 'Exportbestand (.xml)',
  'admin.import.field.intoExisting': 'Ook importeren als deze site al inhoud heeft',
  'admin.import.field.intoExisting.hint':
    "Zonder dit vinkje wordt een import in een site met pagina's of artikelen geweigerd, zodat er niets dubbel bijkomt.",
  'admin.import.upload.button': 'Bestand controleren',
  'admin.import.done.uploaded':
    'Bestand gecontroleerd. Lees het rapport hieronder en start dan de import.',
  'admin.import.done.confirmed':
    'De import is gestart. Laad deze pagina opnieuw om te zien hoe ver hij is.',
  'admin.import.done.deleted': 'Import verwijderd. Wat hij importeerde blijft staan.',
  'admin.import.error.noFile': 'Kies eerst een exportbestand.',
  'admin.import.error.unreadable':
    'Dit bestand is geen WordPress-export. Exporteer opnieuw met Gereedschap → Exporteren → Alle inhoud.',
  'admin.import.error.tooLarge': 'Het bestand is groter dan 25 MB.',
  'admin.import.error.busy':
    'Er loopt nog een andere import van deze site. Wacht tot die klaar is.',
  'admin.import.error.notPlanned': 'Deze import is al gestart of klaar.',
  'admin.import.plan.title': 'Klaar om te importeren',
  'admin.import.plan.from': 'Uit {site}',
  'admin.import.plan.locales': 'Talen: {locales}',
  'admin.import.plan.start': 'Import starten',
  'admin.import.plan.discard': 'Weggooien',
  'admin.import.plan.intoExisting': 'Importeert ook als deze site al inhoud heeft.',
  'admin.import.count.pages': "Pagina's",
  'admin.import.count.articles': 'Artikelen',
  'admin.import.count.media': 'Bestanden',
  'admin.import.count.people': 'Personen',
  'admin.import.count.groups': 'Persoonsgroepen',
  'admin.import.count.sections': 'Rubrieken',
  'admin.import.count.campaigns': 'Campagnes',
  'admin.import.count.drafts': '{n} als concept',
  'admin.import.count.label': 'Wat',
  'admin.import.count.number': 'Aantal',
  'admin.import.report.title': 'Opmerkingen',
  'admin.import.report.none': 'Geen opmerkingen: alles komt mee zoals het is.',
  'admin.import.report.more.one': 'En nog {n} opmerking die niet in de lijst staat.',
  'admin.import.report.more.other': 'En nog {n} opmerkingen die niet in de lijst staan.',
  'admin.import.report.post': 'bericht {id}',
  'admin.import.running.title': 'Bezig met importeren',
  'admin.import.running.text':
    'De import loopt op de achtergrond; bij een grote site kan dat een paar minuten duren. Laad de pagina opnieuw om te zien of hij klaar is.',
  'admin.import.refresh': 'Vernieuwen',
  'admin.import.list.title': 'Eerdere imports',
  'admin.import.list.none': 'Er is nog niets geïmporteerd.',
  'admin.import.col.when': 'Geüpload',
  'admin.import.col.file': 'Bestand',
  'admin.import.col.status': 'Status',
  'admin.import.col.result': 'Resultaat',
  'admin.import.status.planned': 'Gecontroleerd, niet gestart',
  'admin.import.status.queued': 'Wacht op start',
  'admin.import.status.running': 'Bezig met importeren',
  'admin.import.status.done': 'Geïmporteerd',
  'admin.import.status.failed': 'Mislukt',
  'admin.import.result.items.one': '{n} item gemaakt',
  'admin.import.result.items.other': '{n} items gemaakt',
  'admin.import.result.title': 'Laatste import',
  'admin.import.result.content': 'Bekijk de inhoudslijst',
  'admin.import.code.other': 'Overige opmerkingen',
  'admin.import.code.block.skipped': 'Blokken weggelaten (geen tegenhanger in Mycel)',
  'admin.import.code.block.shortcode': 'Shortcodes weggelaten',
  'admin.import.code.block.unwrapped': 'Groepen en kolommen uitgepakt (hun opmaak blijft niet)',
  'admin.import.code.image.alt-missing':
    'Beelden geplaatst zonder alt-tekst (beschrijf ze in het beheer)',
  'admin.import.code.block.invalid': 'Blokken die niet klopten (weggelaten)',
  'admin.import.code.block.media-missing':
    'Blokken waarvan het bestand niet in de export zit (weggelaten)',
  'admin.import.code.block.people-missing':
    'Personenrasters waarvan de personen of categorie niet in de export zitten (weggelaten)',
  'admin.import.code.people.missing': 'Personen in een raster die niet in de export zitten',
  'admin.import.code.block.items-missing':
    'Rasters en losse items waarvan de berichten niet in de export zitten (weggelaten)',
  'admin.import.code.items.missing':
    'Berichten in een raster of categorie die niet in de export zitten',
  'admin.import.code.overview.more-dropped':
    'Overzichten waarvan de link "alle berichten" of "alle evenementen" nog geen Mycel-pagina heeft',
  'admin.import.code.overview.dossier-split':
    "Dossierrasters van artikelen en pagina's gesplitst in twee overzichten",
  'admin.import.code.person.link-invalid':
    'Sociale links van personen die geen geldig adres zijn (weggelaten)',
  'admin.import.code.person.bio-too-long':
    'Beschrijvingen van personen langer dan 5000 tekens (niet gebruikt)',
  'admin.import.code.hero.extra': 'Tweede hero in één bericht (weggelaten)',
  'admin.import.code.hero.action-dropped': 'Knoppen in een hero niet overgenomen',
  'admin.import.code.video.title-from-item': "Video's die de titel van hun bericht kregen",
  'admin.import.code.timeline.date-completed': 'Tijdlijndatums aangevuld tot een volledige datum',
  'admin.import.code.timeline.event-without-date':
    'Tijdlijngebeurtenissen zonder datum (weggelaten)',
  'admin.import.code.item.invalid': 'Items die niet klopten (niet geïmporteerd)',
  'admin.import.code.item.private': 'Privé-items (als concept geïmporteerd)',
  'admin.import.code.item.scheduled': 'Ingeplande items (als concept geïmporteerd)',
  'admin.import.code.item.slug-changed': 'Adressen gewijzigd (oud → nieuw)',
  'admin.import.code.item.parent-flattened': "Subpagina's (bovenliggende pagina niet bewaard)",
  'admin.import.code.item.section-extra': 'Extra categorieën (alleen de eerste wordt de rubriek)',
  'admin.import.code.item.tag-invalid': 'Tags geweigerd',
  'admin.import.code.item.excerpt-too-long':
    'Samenvattingen langer dan 500 tekens (niet als beschrijving gebruikt)',
  'admin.import.code.dossier.unlinked':
    'Dossiers zonder landingspagina (lidmaatschap niet bewaard)',
  'admin.import.code.dossier.ambiguous':
    "Dossiers die door twee landingspagina's worden geclaimd (lidmaatschap niet bewaard)",
  'admin.import.code.dossier.extra':
    'Dossiers boven de drie per item, of op een dossierpagina (niet bewaard)',
  'admin.import.code.campaign.form-missing':
    'Campagnes zonder formulier: koppel er een en open dan deelname',
  'admin.import.code.campaign.history-in-source':
    'Campagnegeschiedenis die in de bronadministratie blijft',
  'admin.import.code.campaign.confirmation':
    'Bevestigingsbeleid van elke bronactie (herhaal het op het formulier)',
  'admin.import.code.campaign.goal-milestones':
    'Campagnes met tussendoelen in de bron (stel ze opnieuw in)',
  'admin.import.code.campaign.goal-invalid': 'Campagnedoelen buiten bereik (niet gebruikt)',
  'admin.import.code.campaign.archive':
    'Oude campagnearchieven (doorverwijzen naar de index van hun soort)',
  'admin.import.code.campaign.failed': 'Campagnes niet gemaakt',
  'admin.import.code.translation.not-merged':
    'Vertalingen niet samengevoegd: structuur wijkt af (niet geïmporteerd)',
  'admin.import.code.translation.value-differs':
    'Vertaalde waarden die verschillen (standaardtaal aangehouden)',
  'admin.import.code.media.failed': 'Bestanden niet geüpload',
  'admin.import.code.person.failed': 'Personen niet aangemaakt',
  'admin.import.code.group.failed': 'Persoonsgroepen niet aangemaakt',
  'admin.import.code.section.failed': 'Rubrieken niet aangemaakt',
  'admin.import.code.item.failed': 'Items niet aangemaakt',
  'admin.import.code.item.blocks-failed':
    'Items waarvan de blokken met links niet zijn opgeslagen (aangemaakt zonder blokken)',
  'admin.import.code.item.publish-failed': 'Talen niet gepubliceerd (als concept gelaten)',
  'admin.import.code.item.image-missing':
    'Kop- of uitgelichte beelden waarvan het bestand niet meekwam',
  'admin.import.code.block.reference-missing':
    'Blokken waarvan het bestand of het gelinkte item niet meekwam (weggelaten)',
};
