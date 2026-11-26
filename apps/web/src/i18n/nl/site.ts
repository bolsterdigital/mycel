// Site settings, site navigation, domains and locales.

import type { UiKey } from '../en.js';

export const site: Partial<Record<UiKey, string>> = {
  'admin.site.title': 'Site-instellingen',
  'admin.site.brand': 'Logo en woordmerk',
  'admin.site.logo': 'Logo',
  'admin.site.wordmarkFont': 'Woordmerkfont',
  'admin.site.active': 'Actief',
  'admin.site.file': 'Bestand',
  'admin.site.licence': 'Fontlicentie',
  'admin.site.upload': 'Uploaden',
  'admin.site.replace': 'Vervangen',
  'admin.site.remove': 'Verwijderen',
  'admin.site.theme': 'Thema',
  'admin.site.foreground': 'Tekstkleur',
  'admin.site.background': 'Achtergrondkleur',
  'admin.site.colours.role': 'Rol',
  'admin.site.colours.contrast': 'Contrast',
  'admin.site.unit.px': 'px',
  'admin.site.unit.characters': 'tekens',
  'admin.site.pass': 'voldoet',
  'admin.site.fail': 'voldoet niet',
  'admin.site.headingFont': 'Kopletter',
  'admin.site.bodyFont': 'Tekstletter',
  'admin.site.font.uploaded':
    'Deze site gebruikt een eigen letter: {family}, geüpload door de platformbeheerder. De keuze hier geldt alleen voor mail en de deelkaart.',
  'admin.site.font.specimen': 'Samen staan we sterker',
  'admin.site.font.weightUnavailable':
    'De kopletter heeft geen variant in deze kopdikte. Kies een andere dikte of een andere letter.',
  'admin.site.dropCap': 'Initiaal op artikelen',
  'admin.site.dropCap.hint': 'Een grote eerste letter aan het begin van de tekst van elk artikel.',
  'admin.site.dropCap.articles': 'Aan',
  'admin.site.dropCap.off': 'Uit',
  'admin.site.pageTransitions': "Overgangen tussen pagina's",
  'admin.site.pageTransitions.hint':
    'Klikt een bezoeker naar een andere pagina, dan vloeit die in terwijl kop en voet blijven staan. Wie op zijn apparaat om minder beweging vroeg, ziet het nooit.',
  'admin.site.pageTransitions.on': 'Aan',
  'admin.site.pageTransitions.off': 'Uit',
  'admin.site.group.chrome': 'Kop en voet',
  'admin.site.chrome.header': 'Kleur van de kop',
  'admin.site.chrome.header.hint':
    'Het kleurenpaar van de balk met sitenaam en menu bovenaan elke pagina.',
  'admin.site.chrome.footer': 'Kleur van de voet',
  'admin.site.chrome.footer.hint': 'Het kleurenpaar van de voettekst onderaan elke pagina.',
  'admin.site.captionFont': 'Lettertype van onderschriften',
  'admin.site.captionFont.hint':
    'Het lettertype van onderschriften en naamsvermeldingen bij foto’s, video’s en galerijen.',
  'admin.site.captionFont.body': 'Zoals de lopende tekst',
  'admin.site.captionFont.mono': 'Monospace (schrijfmachine)',
  'admin.site.buttonShape': 'Knopvorm',
  'admin.site.buttonShape.theme': 'Hoekafronding van het thema',
  'admin.site.buttonShape.pill': 'Volledig afgerond',
  'admin.site.headingCase': 'Koppen en knoppen',
  'admin.site.headingCase.hint':
    'Hoe koppen, kaarttitels en knoppen worden gezet. Kapitalen veranderen alleen hoe ze eruitzien; de tekst zelf blijft zoals hij is geschreven.',
  'admin.site.headingCase.normal': 'Zoals geschreven',
  'admin.site.headingCase.upper': 'In kapitalen',
  'admin.site.images': 'Beeld',
  'admin.site.defaultImage': 'Standaardbeeld',
  'admin.site.defaultImage.hint':
    'Het beeld dat een pagina of artikel zonder eigen uitgelicht beeld of deelbeeld gebruikt, bijvoorbeeld bij delen op sociale media.',
  'admin.site.defaultImage.save': 'Beeld opslaan',
  'admin.site.workCredits': 'Werk en maker vermelden',
  'admin.site.workCredits.hint':
    'Voor een site die kunstwerken of ander werk toont: een beeld krijgt dan naast de maker van het beeld een tweede vermelding met titel en maker van het werk.',
  'admin.site.identity': 'Logo in de kop',
  'admin.site.logoHasName': 'Het logo bevat de naam van de site',
  'admin.site.logoHasName.hint':
    'Dan toont de kop alleen het logo, zonder de naam ernaast; schermlezers horen de naam nog steeds.',
  'admin.site.saveIdentity': 'Logo-instelling opslaan',
  'admin.site.social': 'Sociale media',
  'admin.site.saveSocial': 'Sociale media opslaan',
  'admin.site.social.hint':
    'Een ingevuld profiel staat als icoon onder "Volg ons" in de voettekst; een leeg veld toont niets. Een profiel is een https-adres.',
  'admin.site.social.email': 'E-mailadres',
  'admin.site.social.website': 'Website',
  'admin.site.mode.light': 'Lichte kleuren',
  'admin.site.mode.dark': 'Donkere kleuren',
  'admin.site.role.body': 'Lopende tekst',
  'admin.site.role.surface': 'Vlak',
  'admin.site.role.primary': 'Primair',
  'admin.site.role.accent': 'Accent',
  'admin.site.role.muted': 'Gedempt',
  'admin.site.role.warning': 'Waarschuwing',
  'admin.site.role.link': 'Link',
  'admin.site.role.focus': 'Focus',
  'admin.site.role.ctaHighlight': 'Uitgelichte oproep',
  'admin.site.role.campaignForm': 'Campagneformulier',
  'admin.site.role.campaignProgress': 'Campagnevoortgang',
  'admin.site.role.campaignProgressFill': 'Vulling voortgangsbalk',
  'admin.site.role.card': 'Kaart {n}',
  'admin.site.cards.hint':
    'Kaart 1 tot 4 zijn de kleuren van een actierij, kaart na kaart; een rij met meer kaarten dan kleuren begint weer bij de eerste. Laat beide velden leeg om een kaart niet te gebruiken; zonder kaartkleuren is een kaart primair en een balk accent.',
  'admin.site.field.baseSize': 'Basistekstgrootte',
  'admin.site.field.scaleRatio': 'Schaalverhouding',
  'admin.site.field.measure': 'Tekstbreedte',
  'admin.site.field.radius': 'Hoekafronding',
  'admin.site.field.density': 'Ruimte tussen elementen',
  'admin.site.field.headingWeight': 'Kopdikte',
  'admin.site.saveTheme': 'Thema opslaan',
  'admin.site.chrome': 'Voettekst',
  'admin.site.saveChrome': 'Voettekst opslaan',
  'admin.site.chrome.menus': "De menu's van kop en voet stel je in onder",
  'admin.site.footer': 'Voettekst',
  'admin.site.conflict':
    'Deze instellingen zijn elders gewijzigd. Controleer je invoer en laad opnieuw voordat je opslaat.',
  'admin.site.invalid': 'Controleer de velden en het kleurcontrast.',
  'admin.site.saved': 'Instellingen opgeslagen.',
  'admin.navigation.title': 'Navigatie',
  'admin.navigation.intro':
    "De menu's van je site. Bouw hier een menu; hetzelfde menu kan straks in de kop en in de footer staan.",
  'admin.navigation.menus': "Menu's",
  'admin.navigation.newMenu': 'Nieuw menu',
  'admin.navigation.newMenu.intro':
    'Geef het menu eerst een naam; de items voeg je op het volgende scherm toe.',
  'admin.navigation.newMenu.submit': 'Menu aanmaken',
  'admin.navigation.empty': "Nog geen menu's",
  'admin.navigation.empty.body':
    'Een menu is een lijst links, zoals het hoofdmenu of de links in de footer.',
  'admin.navigation.column.name': 'Menu',
  'admin.navigation.column.items': 'Items',
  'admin.navigation.column.used': 'Gebruikt in',
  'admin.navigation.placement.main': 'Hoofdnavigatie',
  'admin.navigation.placement.actions': 'Actieknoppen',
  'admin.navigation.placement.footer': 'Footer',
  'admin.navigation.placement.legal': 'Juridische links',
  'admin.navigation.placement.prefooter': 'Pre-footer',
  'admin.navigation.notPlaced': 'Niet geplaatst',
  'admin.navigation.notPlaced.long': 'Dit menu staat nog nergens op de site.',
  'admin.navigation.usedIn':
    'Gebruikt in: {places}. Een wijziging hier is na publicatie op al die plekken te zien.',
  'admin.navigation.items': 'Items',
  'admin.navigation.items.intro':
    'In de volgorde waarin bezoekers ze zien, met de tekst die ze lezen in {locale}.',
  'admin.navigation.items.empty': 'Dit menu heeft nog geen items',
  'admin.navigation.items.empty.body':
    'Voeg een link naar een pagina toe, of een groep om links onder te zetten.',
  'admin.navigation.subItemsOf': 'Subitems van {name}',
  'admin.navigation.addLink': 'Link toevoegen',
  'admin.navigation.addGroup': 'Groep toevoegen',
  'admin.navigation.editLink': 'Link bewerken',
  'admin.navigation.editGroup': 'Groep bewerken',
  'admin.navigation.edit': 'Bewerken',
  'admin.navigation.save': 'Opslaan',
  'admin.navigation.saved':
    'Opgeslagen als concept. Op de site verandert niets tot de navigatie is gepubliceerd.',
  'admin.navigation.merged':
    'Opgeslagen, samen met een wijziging die iemand anders intussen maakte.',
  'admin.navigation.rename': 'Naam opslaan',
  'admin.navigation.remove': 'Verwijderen',
  'admin.navigation.remove.question': 'Dit item uit het menu verwijderen?',
  'admin.navigation.remove.questionSub':
    'Dit item en de subitems eronder uit het menu verwijderen?',
  'admin.navigation.remove.confirm': 'Ja, verwijderen',
  'admin.navigation.delete': 'Menu verwijderen',
  'admin.navigation.delete.question': 'Dit menu met al zijn items verwijderen?',
  'admin.navigation.delete.confirm': 'Ja, menu verwijderen',
  'admin.navigation.delete.placed':
    'Dit menu is in gebruik op de site. Kies eerst een ander menu voor die plekken.',
  'admin.navigation.move.up': 'Omhoog',
  'admin.navigation.move.down': 'Omlaag',
  'admin.navigation.move.in': 'Maak subitem',
  'admin.navigation.move.out': 'Naar hoofdniveau',
  'admin.navigation.kind.group': 'Groep',
  'admin.navigation.leadsTo': 'Gaat naar {target}',
  'admin.navigation.noLabel': '(geen tekst)',
  'admin.navigation.system.home': 'Startpagina',
  'admin.navigation.system.search': 'Zoekpagina',
  'admin.navigation.source.own': 'Eigen menutekst',
  'admin.navigation.source.featured': 'Uitgelichte titel van de pagina',
  'admin.navigation.source.title': 'Paginatitel',
  'admin.navigation.source.system': 'Standaardnaam',
  'admin.navigation.state.unpublished': 'Pagina niet gepubliceerd',
  'admin.navigation.state.restricted': 'Alleen voor leden: bezoekers zien de inleiding',
  'admin.navigation.state.missing': 'Pagina bestaat niet meer',
  'admin.navigation.state.noLabel': 'Geen tekst in {locale}',
  'admin.navigation.field.name': 'Naam',
  'admin.navigation.field.name.hint': 'Voor jou en je team; bezoekers zien hem nooit.',
  'admin.navigation.field.label': 'Menutekst',
  'admin.navigation.field.label.in': 'Menutekst ({locale})',
  'admin.navigation.field.label.hint':
    'Laat leeg om de titel van de pagina te gebruiken. Een adres heeft een eigen tekst nodig.',
  'admin.navigation.field.label.inherits':
    'Laat leeg om de titel van de pagina te gebruiken: "{title}".',
  'admin.navigation.field.label.inheritsRestricted':
    'Laat leeg om de titel van de pagina te gebruiken: "{title}". De pagina is alleen voor leden: bezoekers zien de link en de inleiding.',
  'admin.navigation.field.label.groupHint': 'De tekst boven de subitems.',
  'admin.navigation.field.url.hint': 'Begint met / voor een plek op deze site, of met https://.',
  'admin.navigation.field.anchor': 'Waar op de pagina',
  'admin.navigation.field.anchor.hint':
    'De link opent de pagina bij dit deel. Andere pagina gekozen? Sla eerst op en kies dan een deel ervan.',
  'admin.navigation.anchor.none': 'Bovenaan',
  'admin.navigation.anchor.option': '{type}: {text}',
  'admin.navigation.anchor.gone': 'Een deel dat er niet meer is',
  'admin.navigation.anchor.empty': '{part} (toont nu niets op de site)',
  'admin.navigation.anchor.unpublished':
    'Zodra de pagina in {locale} gepubliceerd is, kun je kiezen waar op de pagina de link uitkomt.',
  'admin.navigation.anchor.later':
    'Na het opslaan van een link naar een pagina kun je kiezen waar op die pagina hij uitkomt.',
  'admin.navigation.group.intro':
    'Een groep is een tekst zonder eigen link. Voeg links toe en maak ze daarna subitem van de groep.',
  'admin.navigation.error.conflict':
    'Niet opgeslagen: iemand heeft hetzelfde deel van de navigatie intussen gewijzigd. Wat die persoon opsloeg, staat er nu; bekijk het en probeer het dan nog eens.',
  'admin.navigation.error.invalid':
    'Niet opgeslagen: met wat intussen is gewijzigd past dit niet meer. Laad de pagina opnieuw en probeer het nog eens.',
  'admin.navigation.error.nameRequired': 'Geef het menu een naam.',
  'admin.navigation.error.labelRequired':
    'Een groep en een adres hebben geen titel om over te nemen: vul de menutekst in.',
  'admin.navigation.error.address': 'Vul een adres in dat begint met / of https://.',
  'admin.navigation.error.targetRequired': 'Kies waar de link naartoe gaat.',
  'admin.navigation.error.targetGone': 'Die pagina bestaat niet meer. Kies een andere.',
  'admin.navigation.error.menuPlaced':
    'Dit menu is in gebruik op de site. Kies eerst een ander menu voor die plekken.',
  'admin.navigation.error.menuPublished':
    'Dit menu staat in een gepubliceerde taal op de site. Haal het eerst van zijn plek en publiceer dat.',
  'admin.navigation.error.budget':
    "Niet opgeslagen: de navigatie heeft het maximale aantal menu's of items bereikt.",
  'admin.navigation.error.actions':
    'Niet opgeslagen: de actieknoppen bevatten hooguit twee links, zonder subitems of groepen.',
  'admin.navigation.error.yours': 'Wat jij had ingevuld: {text}',
  'admin.navigation.error.notAZone':
    'Niet opgeslagen: de pre-footer moet een zone zijn. Kies een zone uit de lijst.',
  'admin.navigation.error.yoursChoices': 'Wat jij had gekozen: {choices}.',
  'admin.navigation.error.publish':
    'Niet gepubliceerd: los eerst op wat hieronder "Blokkeert publicatie" heeft.',
  'admin.navigation.error.revisionGone': 'Die versie van de navigatie bestaat niet.',
  'admin.navigation.overview.published': 'Gepubliceerd in {locale}.',
  'admin.navigation.overview.offline': 'Offline gehaald in {locale}.',
  'admin.navigation.overview.restored':
    'Teruggezet als concept. Op de site verandert niets tot je het publiceert.',
  'admin.navigation.placements': 'Plaatsingen',
  'admin.navigation.placements.intro':
    'Waar het concept elk menu toont. Hetzelfde menu mag op meerdere plekken staan.',
  'admin.navigation.placements.edit': 'Plaatsingen wijzigen',
  'admin.navigation.placements.submit': 'Plaatsingen opslaan',
  'admin.navigation.placements.none': 'Geen',
  'admin.navigation.placements.noMenus': 'Maak eerst een menu; kies daarna waar het staat.',
  'admin.navigation.placements.main.hint':
    'Het hele menu opent als paneel. De items die je hieronder aanvinkt, staan ook in de balk als er ruimte is.',
  'admin.navigation.placements.bar': 'In de balk',
  'admin.navigation.placements.bar.hint':
    'Items op het hoofdniveau van {menu}. Kies je een ander menu, sla dan eerst op en vink daarna de items aan.',
  'admin.navigation.placements.bar.empty': 'Dit menu heeft nog geen items.',
  'admin.navigation.placements.actions.hint':
    'Een menu van hooguit twee links zonder subitems: de eerste is de hoofdknop, de tweede de andere.',
  'admin.navigation.placements.footer.hint':
    'Hooguit vier kolommen, in deze volgorde. Laat een kolom op "Geen" staan om hem over te slaan.',
  'admin.navigation.placements.column': 'Kolom {n}',
  'admin.navigation.placements.column.menu': 'Menu van kolom {n}',
  'admin.navigation.placements.column.title': 'Titel van kolom {n} ({locale})',
  'admin.navigation.placements.column.title.hint': 'Mag leeg blijven; staat boven de kolom.',
  'admin.navigation.placements.legal.hint':
    'Privacy, voorwaarden en andere juridische links, in kleine letters.',
  'admin.navigation.publication': 'Publicatie',
  'admin.navigation.placements.prefooter.zone': 'Zone',
  'admin.navigation.placements.prefooter.hint':
    'De strook tussen de inhoud en de voet van elke pagina en elk artikel. Een zone maak je onder Zones.',
  'admin.navigation.publication.intro':
    "Per taal: welke versie bezoekers krijgen zodra de site deze menu's gebruikt, en of het concept sindsdien is gewijzigd.",
  'admin.navigation.column.language': 'Taal',
  'admin.navigation.column.live': 'Live',
  'admin.navigation.column.draft': 'Concept',
  'admin.navigation.live.none': 'Niet gepubliceerd',
  'admin.navigation.draft.same': 'Gelijk aan live',
  'admin.navigation.draft.ahead': 'Gewijzigd',
  'admin.navigation.draft.blocked': 'Kan nog niet gepubliceerd worden',
  'admin.navigation.previewIn': 'Voorbeeld {locale}',
  'admin.navigation.revisions': 'Versies',
  'admin.navigation.revisions.intro':
    'De nieuwste versies van het concept, nieuwste eerst. Elke opgeslagen stap maakt er een.',
  'admin.navigation.revisions.all': 'Alle versies',
  'admin.navigation.column.when': 'Opgeslagen',
  'admin.navigation.column.notes': 'Bijzonderheden',
  'admin.navigation.revision.current': 'Huidig concept',
  'admin.navigation.revision.merged': 'Samengevoegd met een gelijktijdige wijziging',
  'admin.navigation.revision.restoredFrom': 'Teruggezet uit de versie van {when}',
  'admin.navigation.revision.restored': 'Teruggezet uit een oudere versie',
  'admin.navigation.revision.liveIn': 'Live in {locales}',
  'admin.navigation.revision.view': 'Bekijken',
  'admin.navigation.revision.title': 'Versie van {when}',
  'admin.navigation.revision.intro':
    'Wat deze versie bezoekers in {locale} toont, met de pagina’s zoals ze nu gepubliceerd zijn. Terugzetten kopieert hem naar een nieuw concept.',
  'admin.navigation.revision.isCurrent': 'Dit is het huidige concept.',
  'admin.navigation.restore': 'Terugzetten als concept',
  'admin.navigation.restore.question':
    'Deze versie het concept maken? Het huidige concept blijft in de lijst met versies, en er gaat niets live tot je publiceert.',
  'admin.navigation.restore.confirm': 'Ja, terugzetten',
  'admin.navigation.preview.title': 'Voorbeeld in {locale}',
  'admin.navigation.preview.intro':
    'Wat bezoekers in {locale} zien als dit concept gepubliceerd wordt: alleen gepubliceerde pagina’s, met hun gepubliceerde titels.',
  'admin.navigation.preview.live': 'Live in {locale}: de versie van {when}.',
  'admin.navigation.preview.notLive': 'Nog niet gepubliceerd in {locale}.',
  'admin.navigation.preview.same': 'Het concept is wat live staat.',
  'admin.navigation.preview.ahead': 'Het concept heeft wijzigingen die nog niet live staan.',
  'admin.navigation.preview.nothing': 'Hier staat niets.',
  'admin.navigation.preview.empty': 'Toont niets in deze taal.',
  'admin.navigation.preview.bar': 'In de balk',
  'admin.navigation.preview.primary': 'Hoofdknop',
  'admin.navigation.preview.secondary': 'Andere knop',
  'admin.navigation.preview.untitled': 'Kolom zonder titel',
  'admin.navigation.preview.menu': 'Menu: {menu}',
  'admin.navigation.problems': 'Weggelaten',
  'admin.navigation.problems.intro':
    "Items van geplaatste menu's die bezoekers in {locale} niet zien.",
  'admin.navigation.problems.none': "Elk item van de geplaatste menu's wordt getoond.",
  'admin.navigation.problem.blocking': 'Blokkeert publicatie',
  'admin.navigation.problem.where': '{item} in {menu}',
  'admin.navigation.problem.label-missing':
    'Het heeft geen tekst in {locale}; vul die in voor je publiceert.',
  'admin.navigation.problem.target-unavailable': 'De pagina is niet gepubliceerd in {locale}.',
  'admin.navigation.problem.children-unreachable':
    'De pagina wordt niet getoond en het item heeft geen eigen tekst in {locale}, dus de subitems vallen ook weg.',
  'admin.navigation.problem.anchor-missing':
    'Het deel van de pagina waar het naar wees, is weg; het gaat naar het begin van de pagina.',
  'admin.navigation.problem.anchor-empty':
    'Het deel van de pagina waar het naar wijst, toont nu niets op de site, bijvoorbeeld een beeld dat niet openbaar is; het gaat naar het begin van de pagina.',
  'admin.navigation.problem.target-unknown':
    'De pagina bestaat niet meer; kies een andere voor je publiceert.',
  'admin.navigation.publish': 'Publiceren in {locale}',
  'admin.navigation.publish.noRight':
    'Publiceren vraagt het recht om te publiceren. Iemand die dat heeft, kan dit concept live zetten.',
  'admin.navigation.unpublish': 'Offline halen in {locale}',
  'admin.navigation.unpublish.question':
    "De menu's in deze taal offline halen? Bezoekers zien daar dan geen menu's tot je opnieuw publiceert.",
  'admin.navigation.unpublish.confirm': 'Ja, offline halen',
  'admin.domains.title': 'Domeinen',
  'admin.domains.intro':
    'De site wordt geserveerd op de primaire hostnaam, het adres van de site; elke andere hostnaam verwijst daarheen door. Voeg je eigen domein toe, zet de DNS-records, controleer ze en kies het adres.',
  'admin.domains.kind.platform': 'platform-hostnaam',
  'admin.domains.kind.custom': 'eigen domein',
  'admin.domains.primary': 'primair',
  'admin.domains.verified': 'geverifieerd',
  'admin.domains.unverified': 'nog niet geverifieerd',
  'admin.domains.dns.title': 'DNS-records bij je provider',
  'admin.domains.dns.txt': 'TXT-record',
  'admin.domains.dns.cname': 'CNAME-record',
  'admin.domains.dns.name': 'Naam',
  'admin.domains.dns.value': 'Waarde',
  'admin.domains.dns.target': 'Wijst naar',
  'admin.domains.dns.apex':
    'Het kale domein kan geen CNAME krijgen: gebruik een ALIAS- of ANAME-record als je provider dat heeft, anders de A- en AAAA-records uit de documentatie van je hoster. Het TXT-record is altijd nodig.',
  'admin.domains.checks.none':
    'Wordt elke dag gecontroleerd; de eerste controle volgt binnen een dag.',
  'admin.domains.checks.ok': 'Laatst gecontroleerd {when}: het TXT-record is gevonden.',
  'admin.domains.checks.failing':
    'Laatst gecontroleerd {when}: TXT-record {n} dag(en) op rij niet gevonden. Na 3 dagen vervalt de verificatie en wordt de platform-hostname weer primair.',
  'admin.domains.done.unavailable':
    'DNS gaf geen antwoord voor {hostname}, dus er is niets gecontroleerd of veranderd. Probeer het over een paar minuten opnieuw.',
  'admin.domains.check': 'DNS controleren',
  'admin.domains.makePrimary': 'Primair maken',
  'admin.domains.remove': 'Verwijderen',
  'admin.domains.removeQuestion':
    'De site is daarna niet meer op deze hostnaam te bereiken. Je kunt het domein later opnieuw toevoegen en verifiëren.',
  'admin.domains.removeConfirm': 'Ja, verwijderen',
  'admin.domains.add.title': 'Domein toevoegen',
  'admin.domains.add.hostname': 'Hostnaam',
  'admin.domains.add.hint': 'Alleen de hostnaam, zonder https:// en zonder pad.',
  'admin.domains.add.placeholder': 'voorbeeld.nl',
  'admin.domains.kind.main': 'hoofddomein, met www',
  'admin.domains.pair.redirects': '{from} stuurt door naar {to}, het adres van de site.',
  'admin.domains.pair.choose':
    'Beide namen zijn geverifieerd. Kies welke het adres van de site wordt; de andere stuurt daar dan naar door.',
  'admin.domains.pair.later':
    'Zet de records voor beide namen. Zodra beide geverifieerd zijn, kies je welke het adres van de site wordt; de andere stuurt daar dan naar door.',
  'admin.domains.pair.useAs': 'Als adres gebruiken',
  'admin.domains.pair.removeQuestion':
    'Beide namen worden verwijderd en de site is daarna niet meer op die namen te bereiken. Je kunt het domein later opnieuw toevoegen.',
  'admin.domains.checkBoth': 'DNS van beide controleren',
  'admin.domains.dns.alias': 'ALIAS- of ANAME-record',
  'admin.domains.add.scope': 'Wat voor domein is het?',
  'admin.domains.add.scope.main':
    'Het eigen domein van je organisatie, zoals voorbeeld.nl: voorbeeld.nl en www.voorbeeld.nl worden allebei toegevoegd',
  'admin.domains.add.scope.sub':
    'Een los subdomein, zoals campagne.voorbeeld.nl: alleen die naam wordt toegevoegd',
  'admin.domains.done.addedPair':
    'Domeinen {hostname} en www.{hostname} toegevoegd. Zet de DNS-records en controleer ze daarna.',
  'admin.domains.add.submit': 'Domein toevoegen',
  'admin.domains.done.added':
    'Domein {hostname} toegevoegd. Zet de DNS-records en controleer ze daarna.',
  'admin.domains.done.verified': 'Domein {hostname} is geverifieerd.',
  'admin.domains.done.notVerified':
    'Het TXT-record voor {hostname} is nog niet gevonden. Een DNS-wijziging kan tot een uur nodig hebben.',
  'admin.domains.found.txt': 'Gevonden TXT-records: {values}',
  'admin.domains.found.noTxt': 'Geen TXT-record op {name}.',
  'admin.domains.found.cname': 'CNAME wijst naar {target}.',
  'admin.domains.found.cnameOk': 'CNAME wijst naar de platform-hostnaam.',
  'admin.domains.found.noCname':
    'Geen CNAME-record (prima voor een apex-domein met A- en AAAA-records).',
  'admin.domains.done.primary':
    '{hostname} is nu de primaire hostnaam; de andere hostnamen verwijzen erheen.',
  'admin.domains.done.removed': 'Domein {hostname} verwijderd.',
  'admin.domains.error.invalid':
    'Geef een hostnaam zoals www.example.org: zonder poort, pad of IP-adres, en geen hostnaam van het platform zelf.',
  'admin.domains.error.conflict': 'Die hostnaam is al in gebruik.',
  'admin.domains.error.notVerified': 'Verifieer het domein voordat je het primair maakt.',
  'admin.domains.error.isPrimary':
    'Maak eerst een andere hostnaam primair voordat je deze verwijdert.',
  'admin.domains.error.notFound':
    'Dat domein bestaat niet meer op deze site. Laad de pagina opnieuw.',
  'admin.locale.switch': 'Taal van de inhoud',
  'admin.locale.unknown': 'Deze site heeft die taal niet.',
  'admin.locale.state.behind': 'vertaling loopt achter',
  'admin.locale.state.missing': 'nog geen vertaling',
  'admin.locale.translate.title': 'Nog geen versie in {locale}',
  'admin.locale.translate.body':
    'Begin met een kopie van een andere taal en vertaal die veld voor veld, of begin leeg. De andere talen blijven zoals ze zijn.',
  'admin.locale.translate.copy': 'Begin vanuit {locale}',
  'admin.locale.translate.empty': 'Leeg beginnen',
  'admin.locale.translate.assist':
    'Met AI-hulp vertaal je daarna elk veld vanuit een andere taal; zo’n vertaling blijft gemarkeerd tot iemand hem goedkeurt.',
  'admin.site.export.title': 'Export',
  'admin.site.export.body':
    'Alles van deze site in één archief, om te bewaren of naar een andere hoster te verhuizen.',
  'admin.site.export.link': 'Een export maken',
  'admin.site.lead': 'Hoe de site heet en eruitziet, de AI-hulp en wat de site gebruikt.',
  'admin.site.general': 'Algemeen',
  'admin.site.general.name': 'Naam',
  'admin.site.general.locales': 'Talen',
  'admin.site.general.defaultLocale': 'Standaardtaal',
  'admin.site.general.fixed': 'De naam en de talen van de site kun je hier nog niet wijzigen.',
  'admin.site.unsaved': 'Niet opgeslagen wijzigingen',
  'admin.site.group.type': 'Typografie en ruimte',
  'admin.site.general.timeZone': 'Tijdzone',
  'admin.site.general.timeZone.hint':
    'Het beheer plant en toont tijden in deze zone, tenzij iemand onder Voorkeuren een eigen zone koos.',
  'admin.site.general.save': 'Tijdzone opslaan',
  'admin.site.ai.title': 'Gebruik door AI',
  'admin.site.ai.label': 'Wat mogen AI-diensten met de gepubliceerde inhoud?',
  'admin.site.ai.hint':
    'Zoekmachines blijven de site altijd vinden. De keuze staat in robots.txt en in elke pagina; een dienst die zich er niet aan houdt, houdt Mycel niet tegen.',
  'admin.site.ai.open': 'Alles: lezen, antwoorden en trainen',
  'admin.site.ai.no-training': 'Lezen en antwoorden, niet trainen',
  'admin.site.ai.search-only': 'Alleen zoekmachines',
  'admin.site.ai.save': 'AI-keuze opslaan',
  'admin.site.retention.title': 'Bewaartermijnen',
  'admin.site.retention.current':
    'Formulierinzendingen bewaart deze site {months}. Van inlogmomenten van lezers: {days}.',
  'admin.site.retention.months': 'Formulierinzendingen',
  'admin.site.retention.hint':
    'Een kortere termijn verwijdert oudere inzendingen bij de volgende dagelijkse run; ze zijn daarna niet terug te halen.',
  'admin.site.retention.month.one': '{n} maand',
  'admin.site.retention.month.other': '{n} maanden',
  'admin.site.retention.readers': 'Inlogmomenten van lezers',
  'admin.site.retention.readers.hint':
    'Daarna blijft alleen de laatste inlog bewaard. Een kortere termijn verwijdert oudere inlogmomenten bij de volgende dagelijkse run.',
  'admin.site.retention.readers.none': 'alleen de laatste inlog',
  'admin.site.retention.day.one': '{n} dag',
  'admin.site.retention.day.other': '{n} dagen',
  'admin.site.retention.save': 'Termijnen opslaan',
  'admin.site.analytics.title': 'Statistiek',
  'admin.site.analytics.off':
    'Deze site telt niets. Vul een Plausible-site in om bezoeken aan gepubliceerde openbare pagina’s en geaccepteerde aanmeldingen te tellen.',
  'admin.site.analytics.on':
    'Deze site telt bezoeken en geaccepteerde aanmeldingen in de Plausible-site {domain}.',
  'admin.site.analytics.domain': 'Plausible-site',
  'admin.site.analytics.hint':
    'De naam van de site zoals die in Plausible staat, bijvoorbeeld example.org. Laat leeg om te stoppen met tellen; wat Plausible al heeft blijft daar tot je het in Plausible verwijdert.',
  'admin.site.analytics.mismatch':
    'De Plausible-site {domain} hoort niet bij het adres van deze site, {hostname}. Mycel past hem niet aan: verbeter hem hier als het adres is veranderd.',
  'admin.site.analytics.save': 'Statistiek opslaan',
  'admin.site.integrations.title': 'Integraties',
  'admin.site.integrations.off':
    'Op deze site laadt niets van andere diensten. Zet hieronder een videospeler of tagmanager aan; elk laadt pas als de bezoeker daarvoor kiest.',
  'admin.site.integrations.on': 'Aan: {names}. Elk laadt pas als de bezoeker daarvoor kiest.',
  'admin.site.integrations.embed': 'Video’s van {name} in de pagina afspelen',
  'admin.site.integrations.embed.hint':
    'De speler laadt pas van {hosts} als de bezoeker op de video klikt. Uit, of zonder JavaScript, is de video een link naar {name}.',
  'admin.site.integrations.gtm.warning':
    'Tags in je container kunnen alles op de pagina lezen en naar hun makers sturen. Met een tagmanager geldt de belofte van deze site, geen cookies en geen bezoekersprofielen, niet meer; de tags in je container bepalen wat bezoekers delen. Op pagina’s met een formulier of campagnekaart draait hij nooit.',
  'admin.site.integrations.gtm.enable': 'Google Tag Manager laden na toestemming',
  'admin.site.integrations.gtm.hint':
    'Laadt van {hosts}, pas als de bezoeker instemt met de categorie hieronder. Uitzetten bewaart de waarden hier.',
  'admin.site.integrations.gtm.container': 'Container-ID',
  'admin.site.integrations.gtm.container.hint': 'Zoals in Tag Manager, bijvoorbeeld GTM-ABC123.',
  'admin.site.integrations.gtm.category': 'Wacht op toestemming voor',
  'admin.site.integrations.consent.analytics': 'Statistiek',
  'admin.site.integrations.consent.marketing': 'Marketing',
  'admin.site.integrations.gtm.vendors': 'Diensten die de tags mogen bereiken',
  'admin.site.integrations.gtm.vendors.hint':
    'De browser weigert een tag voor elke dienst die hier niet is aangevinkt.',
  'admin.site.integrations.save': 'Integraties opslaan',
};
