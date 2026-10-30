// The words for a refused field in the content editor's publication panel (editor trial 2026-10-28, TODO #60):
// core reports a path (`title.en`, `blocks.2.props.text.nl`), the editor shows the label of the
// field it links to. Pure and client-safe, unlike lib/server; rejected: mapping in the server
// action, which would put copy keys for the same field in two places.

/** Item fields by the head of a core path; `seo` and `featured` read one segment further. */
const FIELD_LABELS: Record<string, string> = {
  title: 'admin.content.field.title',
  lead: 'admin.content.field.lead',
  'seo.title': 'admin.content.field.seoTitle',
  'seo.description': 'admin.content.field.seoDescription',
  'seo.imageId': 'admin.content.field.shareImage',
  heroImageId: 'admin.content.field.heroImage',
  featuredImageId: 'admin.content.field.featuredImage',
  'featured.title': 'admin.content.field.featuredTitle',
  'featured.description': 'admin.content.field.featuredDescription',
  authorIds: 'admin.content.field.authors',
  sectionId: 'admin.content.field.section',
  access: 'admin.content.field.level',
  locales: 'admin.content.new.locales',
  at: 'admin.content.publication.at',
};

/**
 * An issue path as the label of the field it is about (editor trial 2026-10-28, TODO #60): the copy key of that
 * label, the locale it names and, inside a block, the block's position from 1. `null` for a path
 * the editor has no label for; the panel then shows the path itself.
 */
export function issueLabel(
  path: string,
  locales: readonly string[]
): { key: string; locale: string | null; block: number | null } | null {
  const parts = path.split('.');
  const locale = locales.includes(parts.at(-1) ?? '') ? parts.pop()! : null;
  if (parts[0] === 'blocks' && /^\d+$/.test(parts[1] ?? '')) {
    const field = [...parts.slice(2)].reverse().find((p) => !/^\d+$/.test(p) && p !== 'props');
    return field
      ? { key: `admin.block.field.${field}`, locale, block: Number(parts[1]) + 1 }
      : null;
  }
  const nested = parts[0] === 'seo' || parts[0] === 'featured';
  const key = FIELD_LABELS[nested ? parts.slice(0, 2).join('.') : (parts[0] ?? '')];
  return key ? { key, locale, block: null } : null;
}
