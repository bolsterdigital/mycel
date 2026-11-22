// The dry-run report as text for a terminal (brief wordpress-import-execution, PR 1 "Klaar als"):
// counts per kind first, then the blocks left out and the missing alt texts, which are what a
// client migration brief has to redo by hand, then every other remark grouped by its code. The
// report lines themselves stay structured (`ReportLine`), so the admin screen of PR 3 can show
// them through the i18n catalogue instead of this English text.

import type { ImportPlan, ReportCode, ReportLine } from './plan.js';

const HEADINGS: Record<ReportCode, string> = {
  'block.skipped': 'Blocks left out (no Mycel equivalent)',
  'block.shortcode': 'Shortcodes left out',
  'block.unwrapped': 'Groups and columns unwrapped (their look is not kept)',
  'image.alt-missing': 'Images without alt text (not placed)',
  'block.invalid': 'Blocks that did not validate (left out)',
  'block.media-missing': 'Blocks whose file is not in the export (left out)',
  'block.people-missing': 'People grids whose people or category are not in the export (left out)',
  'people.missing': 'People in a grid that are not in the export',
  'block.items-missing': 'Grids and single items whose posts are not in the export (left out)',
  'items.missing': 'Posts in a grid or category that are not in the export',
  'overview.more-dropped': 'Overviews whose "all posts" or "all events" link has no Mycel page yet',
  'person.link-invalid': 'Social links of people that are not a valid address (left out)',
  'person.bio-too-long': 'Descriptions of people over 5000 characters (not used)',
  'hero.extra': 'Second hero on one post (left out)',
  'hero.action-dropped': 'Hero buttons not carried over',
  'video.title-from-item': 'Videos titled after their post',
  'timeline.date-completed': 'Timeline dates completed to a full date',
  'timeline.event-without-date': 'Timeline events without a date (left out)',
  'item.invalid': 'Items that did not validate (not imported)',
  'item.private': 'Private items (imported as draft)',
  'item.scheduled': 'Scheduled items (imported as draft)',
  'item.slug-changed': 'Addresses changed (old → new)',
  'item.parent-flattened': 'Child pages (parent not kept)',
  'item.section-extra': 'Extra categories (only the first is the section)',
  'item.tag-invalid': 'Tags refused',
  'item.excerpt-too-long': 'Excerpts over 500 characters (not used as description)',
  'translation.not-merged': 'Translations not merged: structure differs (not imported)',
  'translation.value-differs': 'Translation values that differ (default language kept)',
  'media.failed': 'Files not uploaded',
  'person.failed': 'People not created',
  'group.failed': 'Person groups not created',
  'section.failed': 'Sections not created',
  'item.failed': 'Items not created',
  'item.blocks-failed': 'Items whose blocks with links were not saved (created without blocks)',
  'item.publish-failed': 'Locales not published (left as draft)',
  'item.image-missing': 'Header or featured images whose file did not come over',
  'block.reference-missing': 'Blocks whose file or linked item did not come over (left out)',
};

/** The codes listed first, in this order; the rest follow in catalogue order. */
const FIRST: ReportCode[] = ['block.skipped', 'block.shortcode', 'image.alt-missing'];

function describe(line: ReportLine): string {
  const where = [
    line.postId !== undefined && `post ${line.postId}`,
    line.title && `"${line.title}"`,
    line.locale && `[${line.locale}]`,
    line.block && `${line.block} #${line.position}`,
  ].filter(Boolean);
  return `  - ${where.join(' ')}${line.detail ? `: ${line.detail}` : ''}`;
}

export function formatReport(plan: ImportPlan): string {
  const count = (type: string, status?: string) =>
    plan.items.filter((i) => i.document.type === type && (!status || i.status === status)).length;
  const out = [
    `WordPress import plan for ${plan.site.title || plan.site.url}`,
    `Default locale ${plan.defaultLocale}; locales ${plan.locales.join(', ')}`,
    `Featured image as article header: ${plan.featuredAsHeader ? 'yes' : 'no'}`,
    '',
    `Pages      ${count('page')} (${count('page', 'draft')} draft)`,
    `Articles   ${count('article')} (${count('article', 'draft')} draft)`,
    `Media      ${plan.media.length}`,
    `People     ${plan.people.length} (${plan.people.filter((p) => p.sourceId !== undefined).length} from Wings people and organisations)`,
    `Groups     ${plan.groups.length}`,
    `Sections   ${plan.sections.length}`,
    `Remarks    ${plan.report.length}`,
  ];
  const codes = [
    ...FIRST,
    ...(Object.keys(HEADINGS) as ReportCode[]).filter((c) => !FIRST.includes(c)),
  ];
  for (const code of codes) {
    const lines = plan.report.filter((l) => l.code === code);
    if (!lines.length) continue;
    out.push('', `${HEADINGS[code]} (${lines.length})`, ...lines.map(describe));
  }
  return `${out.join('\n')}\n`;
}
