// What a closed block card says that the block's own fields do not: the kind of a callout, the
// host of a video, what a form or a paywall is, and why a card keeps the item from being ready.
// Pure, so these words are checked in the screen's language and in the wrong one without a browser
// and a seeded item per case. Rejected: leaving the chains in the edit screen, where only a browser
// could reach them, and putting the words in `textRestOf`, which runs without the screen's language
// and whose result the script brings up to date.
import type { TextRest } from '../server/content/content-blocks.js';
import { fill, type UiKey } from '../../i18n/index.js';

type Translate = (key: UiKey) => string;

function kindLabel(view: TextRest, t: Translate): string | undefined {
  const option = (name: string) => t(`admin.block.option.${name}` as UiKey);
  if (view.kind === 'callout') return option(view.variant);
  if (view.kind === 'video') return option(view.provider);
  if (view.kind === 'paywall') return t('admin.block.paywall.boundary');
  if (view.kind === 'campaign') {
    if (!view.campaign) return t(`admin.block.campaign.reason.${view.reason ?? 'unknown'}`);
    const { kind, phase, participants, target } = view.campaign;
    const state = t(`admin.campaign.state.${phase === 'upcoming' ? 'draft' : phase}`);
    const count =
      participants === null
        ? []
        : [
            target === null
              ? String(participants)
              : fill(t('admin.campaign.count.ofTarget'), { count: participants, target }),
          ];
    return [t(`admin.campaign.kind.${kind}`), state, ...count].join(' · ');
  }
  if (view.kind !== 'form') return undefined;
  if (view.form) return view.form.name ?? view.form.list;
  return t(view.unread ? 'admin.block.form.unread' : 'admin.block.form.missing');
}

/** The two labels `BlockText` takes; `restricted` is whether this item's access holds anyone back. */
export function restWords(
  view: TextRest,
  restricted: boolean,
  t: Translate
): { kindLabel: string | undefined; noteLabel: string | undefined; liveLabel?: string } {
  const note =
    view.kind !== 'paywall'
      ? t('admin.block.form.changed')
      : restricted
        ? undefined
        : t('admin.block.paywall.public');
  return {
    kindLabel: kindLabel(view, t),
    noteLabel: note,
    // A card is a reference that is read when the page is (ADR 033 rule 4): say so at rest.
    ...(view.kind === 'campaign' ? { liveLabel: t('admin.block.campaign.live') } : {}),
  };
}

/** The one notice a card's head carries: what the last save refused, else what readiness says. */
export function blockNotice(
  block: { id: string; refused: boolean },
  publication: readonly { locale: string; issues: readonly { field: string | null }[] }[],
  screen: { work: string; locale: string },
  t: Translate
): string {
  if (block.refused) return t('admin.block.card.refused');
  const locales = publication
    .filter((p) => p.issues.some((x) => x.field === `block-${block.id}`))
    .map((p) => p.locale);
  // The shown locale first: that is the one the editor can act on here.
  const locale = locales.includes(screen.work) ? screen.work : locales[0];
  if (!locale) return '';
  const language = new Intl.DisplayNames([screen.locale], { type: 'language' }).of(locale);
  return fill(t('admin.block.card.notReady'), { locale: language ?? locale });
}
