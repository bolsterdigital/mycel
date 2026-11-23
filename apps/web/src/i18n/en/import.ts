// The site import (MY-257 PR 3): the screen, and one heading per kind of importer remark
// (`admin.import.code.<code>`, the codes of `@mycel/import-wordpress` report.ts).

export const imports = {
  'admin.nav.import': 'Import',
  'admin.manage.hint.import': 'Bring a WordPress site in from its export file.',
  'admin.import.title': 'Import',
  'admin.import.upload.title': 'Import a WordPress site',
  'admin.import.intro':
    'Upload the export of a WordPress or Dreamkit site. You first see what would come over and what would not; nothing is imported until you start it.',
  'admin.import.intro.info':
    'In WordPress: Tools → Export → All content. The file may be up to 25 MB. Images are downloaded from the site itself, so it has to be online. The uploaded file is removed once the import has run.',
  'admin.import.field.file': 'Export file (.xml)',
  'admin.import.field.intoExisting': 'Also import when this site already has content',
  'admin.import.field.intoExisting.hint':
    'Without this an import into a site with pages or articles is refused, so nothing gets added twice.',
  'admin.import.upload.button': 'Check file',
  'admin.import.done.uploaded': 'File checked. Read the report below, then start the import.',
  'admin.import.done.confirmed': 'The import has started. Reload this page to see how far it is.',
  'admin.import.done.deleted': 'Import removed. What it imported stays.',
  'admin.import.error.noFile': 'Choose an export file first.',
  'admin.import.error.unreadable':
    'This file is not a WordPress export. Export again with Tools → Export → All content.',
  'admin.import.error.tooLarge': 'The file is larger than 25 MB.',
  'admin.import.error.busy':
    'Another import of this site is still running. Wait until it is finished.',
  'admin.import.error.notPlanned': 'This import has already started or finished.',
  'admin.import.plan.title': 'Ready to import',
  'admin.import.plan.from': 'From {site}',
  'admin.import.plan.locales': 'Languages: {locales}',
  'admin.import.plan.start': 'Start import',
  'admin.import.plan.discard': 'Discard',
  'admin.import.plan.intoExisting': 'Also imports when this site already has content.',
  'admin.import.count.pages': 'Pages',
  'admin.import.count.articles': 'Articles',
  'admin.import.count.media': 'Files',
  'admin.import.count.people': 'People',
  'admin.import.count.groups': 'Person groups',
  'admin.import.count.sections': 'Sections',
  'admin.import.count.campaigns': 'Campaigns',
  'admin.import.count.drafts': '{n} as draft',
  'admin.import.count.label': 'What',
  'admin.import.count.number': 'Number',
  'admin.import.report.title': 'Remarks',
  'admin.import.report.none': 'No remarks: everything comes over as it is.',
  'admin.import.report.more.one': 'And {n} more remark that is not listed.',
  'admin.import.report.more.other': 'And {n} more remarks that are not listed.',
  'admin.import.report.post': 'post {id}',
  'admin.import.running.title': 'Importing',
  'admin.import.running.text':
    'The import runs in the background; this can take a few minutes for a large site. Reload the page to see whether it is done.',
  'admin.import.refresh': 'Refresh',
  'admin.import.list.title': 'Earlier imports',
  'admin.import.list.none': 'Nothing has been imported yet.',
  'admin.import.col.when': 'Uploaded',
  'admin.import.col.file': 'File',
  'admin.import.col.status': 'Status',
  'admin.import.col.result': 'Result',
  'admin.import.status.planned': 'Checked, not started',
  'admin.import.status.queued': 'Waiting to start',
  'admin.import.status.running': 'Importing',
  'admin.import.status.done': 'Imported',
  'admin.import.status.failed': 'Failed',
  'admin.import.result.items.one': '{n} item made',
  'admin.import.result.items.other': '{n} items made',
  'admin.import.result.title': 'Last import',
  'admin.import.result.content': 'See the content list',
  'admin.import.code.other': 'Other remarks',
  'admin.import.code.block.skipped': 'Blocks left out (no Mycel equivalent)',
  'admin.import.code.block.shortcode': 'Shortcodes left out',
  'admin.import.code.block.unwrapped': 'Groups and columns unwrapped (their look is not kept)',
  'admin.import.code.image.alt-missing':
    'Images placed without alt text (to describe in the admin)',
  'admin.import.code.block.invalid': 'Blocks that did not validate (left out)',
  'admin.import.code.block.media-missing': 'Blocks whose file is not in the export (left out)',
  'admin.import.code.block.people-missing':
    'People grids whose people or category are not in the export (left out)',
  'admin.import.code.people.missing': 'People in a grid that are not in the export',
  'admin.import.code.block.items-missing':
    'Grids and single items whose posts are not in the export (left out)',
  'admin.import.code.items.missing': 'Posts in a grid or category that are not in the export',
  'admin.import.code.overview.more-dropped':
    'Overviews whose "all posts" or "all events" link has no Mycel page yet',
  'admin.import.code.overview.dossier-split':
    'Dossier grids of articles and pages split into two overviews',
  'admin.import.code.person.link-invalid':
    'Social links of people that are not a valid address (left out)',
  'admin.import.code.person.bio-too-long': 'Descriptions of people over 5000 characters (not used)',
  'admin.import.code.hero.extra': 'Second hero on one post (left out)',
  'admin.import.code.hero.action-dropped': 'Hero buttons not carried over',
  'admin.import.code.video.title-from-item': 'Videos titled after their post',
  'admin.import.code.timeline.date-completed': 'Timeline dates completed to a full date',
  'admin.import.code.timeline.event-without-date': 'Timeline events without a date (left out)',
  'admin.import.code.item.invalid': 'Items that did not validate (not imported)',
  'admin.import.code.item.private': 'Private items (imported as draft)',
  'admin.import.code.item.scheduled': 'Scheduled items (imported as draft)',
  'admin.import.code.item.slug-changed': 'Addresses changed (old → new)',
  'admin.import.code.item.parent-flattened': 'Child pages (parent not kept)',
  'admin.import.code.item.section-extra': 'Extra categories (only the first is the section)',
  'admin.import.code.item.tag-invalid': 'Tags refused',
  'admin.import.code.item.excerpt-too-long':
    'Excerpts over 500 characters (not used as description)',
  'admin.import.code.dossier.unlinked': 'Dossiers without a landing page (membership not kept)',
  'admin.import.code.dossier.ambiguous':
    'Dossiers that two landing pages claim (membership not kept)',
  'admin.import.code.dossier.extra':
    'Dossiers beyond three per item, or on a dossier page (not kept)',
  'admin.import.code.campaign.form-missing':
    'Campaigns without a form: bind one, then open participation',
  'admin.import.code.campaign.history-in-source':
    'Campaign history that stays in the source administration',
  'admin.import.code.campaign.confirmation':
    'Confirmation policy of each source action (repeat it on the form)',
  'admin.import.code.campaign.goal-milestones':
    'Campaigns with milestone goals in the source (set them again)',
  'admin.import.code.campaign.goal-invalid': 'Campaign goals out of range (not used)',
  'admin.import.code.campaign.archive':
    'Old campaign archives (redirect to the index of their kind)',
  'admin.import.code.campaign.failed': 'Campaigns not made',
  'admin.import.code.translation.not-merged':
    'Translations not merged: structure differs (not imported)',
  'admin.import.code.translation.value-differs':
    'Translation values that differ (default language kept)',
  'admin.import.code.media.failed': 'Files not uploaded',
  'admin.import.code.person.failed': 'People not created',
  'admin.import.code.group.failed': 'Person groups not created',
  'admin.import.code.section.failed': 'Sections not created',
  'admin.import.code.item.failed': 'Items not created',
  'admin.import.code.item.blocks-failed':
    'Items whose blocks with links were not saved (created without blocks)',
  'admin.import.code.item.publish-failed': 'Locales not published (left as draft)',
  'admin.import.code.item.image-missing': 'Header or featured images whose file did not come over',
  'admin.import.code.block.reference-missing':
    'Blocks whose file or linked item did not come over (left out)',
} as const;
