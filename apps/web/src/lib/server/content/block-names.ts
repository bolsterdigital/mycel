// Prepare validated localized candidates once for server and enhancement. Rejected: the
// preview's pickAny fallback, which makes an unnamed English block acquire unrelated words.
import { BLOCK_DEFINITIONS, type Block, type BlockField } from '@mycel/core';
import type { MediaChoice } from '../../admin/media-choice.js';
import { selectBlockName } from '../../../../static/_admin/block-name.js';

const text = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  const n = value as { text?: string; content?: unknown[] };
  return n.text ?? (n.content ?? []).map(text).join(' ');
};

export function blockNaming(
  block: Block,
  locale: string,
  fallback: string,
  media: readonly MediaChoice[]
) {
  const candidates: {
    field: string;
    values: Record<string, string>;
    rich: boolean;
    localized?: boolean;
    inherited?: Record<string, string>;
  }[] = [];
  const collect = (fields: readonly BlockField[], props: Record<string, unknown>, path: string) => {
    for (const field of fields) {
      const value = props[field.key];
      const at = `${path}.${field.key}`;
      if (
        (field.kind === 'text' && (field.localized || field.key === 'name')) ||
        field.kind === 'rich-text'
      ) {
        const rich = field.kind === 'rich-text';
        const localized = field.kind === 'rich-text' || field.localized;
        const source = localized
          ? (value ?? {})
          : { [locale]: value ?? '', [fallback]: value ?? '' };
        const values = Object.fromEntries(
          Object.entries(source as Record<string, unknown>).map(([l, v]) => [
            l,
            rich ? text(v) : String(v ?? ''),
          ])
        );
        candidates.push({ field: at, values, rich, localized });
      } else if (field.kind === 'group' && value && typeof value === 'object') {
        collect(field.fields, value as Record<string, unknown>, at);
      } else if (field.kind === 'list') {
        const first = (value as Record<string, unknown>[] | undefined)?.[0] ?? {};
        collect(field.fields, first, `${at}.0`);
      }
    }
  };
  let file = '';
  if (block.type === 'image') {
    const asset = media.find((m) => m.id === block.props.mediaId);
    file = asset?.label ?? block.props.mediaId;
    const inherited = asset?.card?.caption ?? {};
    candidates.push({
      field: `b.${block.id}.p.caption`,
      values: { ...inherited, ...block.props.caption },
      rich: false,
      inherited,
    });
  } else
    collect(
      BLOCK_DEFINITIONS[block.type].fields,
      block.props as Record<string, unknown>,
      `b.${block.id}.p`
    );
  const names = block.name ?? {};
  return {
    names,
    candidates,
    locale,
    fallback,
    file,
    ...selectBlockName(
      names,
      candidates.map((c) => c.values),
      locale,
      fallback,
      file
    ),
  };
}
