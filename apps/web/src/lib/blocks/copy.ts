// The words a render model carries for the components (ADR 007: copy in the catalogs only), in
// the item's locale. Its own module so the resolver stays one subject; resolve.ts re-exports it.
// Rejected: each component reading the catalog itself, which would put the locale lookup in
// every component and keep the preview from rendering the page's locale beside the admin's.
import { ui } from '../../i18n/index.js';
import { creditWords } from './credit.js';
import type { BlockCopy } from './model.js';

export function blockCopy(locale: string): BlockCopy {
  const t = ui(locale);
  return {
    callout: {
      info: t('block.callout.info'),
      note: t('block.callout.note'),
      warning: t('block.callout.warning'),
    },
    galleryRow: t('block.gallery.row'),
    audioDownload: t('block.audio.download'),
    audioTranscript: t('block.audio.transcript'),
    credit: creditWords(t),
    videoOn: t('block.video.on'),
    socialConversation: t('block.socialConversation.title'),
    videoPlay: t('block.video.play'),
    videoCredit: t('block.video.credit'),
    videoYouTube: t('block.video.youtube'),
    footnotes: t('block.footnotes'),
    footnoteBack: t('block.footnote.back'),
    toContent: t('block.cover.toContent'),
    timelineNow: t('block.timeline.now'),
    lightbox: {
      enlarge: t('block.lightbox.enlarge'),
      dialog: t('block.lightbox.dialog'),
      close: t('block.lightbox.close'),
      previous: t('block.lightbox.previous'),
      next: t('block.lightbox.next'),
      zoom: t('block.lightbox.zoom'),
      count: t('block.lightbox.count'),
    },
    honeypotLabel: t('form.honeypot.label'),
    summaryTitle: t('error.summary.title'),
    membershipUnavailable: t('forms.membership.unavailable'),
    campaign: {
      kind: {
        petition: t('block.campaign.kind.petition'),
        signup: t('block.campaign.kind.signup'),
        fundraiser: t('block.campaign.kind.fundraiser'),
      },
      phase: {
        upcoming: t('block.campaign.phase.upcoming'),
        open: t('block.campaign.phase.open'),
        closed: t('block.campaign.phase.closed'),
      },
      unit: {
        petition: t('block.campaign.unit.petition'),
        signup: t('block.campaign.unit.signup'),
        fundraiser: t('block.campaign.unit.fundraiser'),
      },
      goal: t('block.campaign.goal'),
      none: {
        petition: t('block.campaign.none.petition'),
        signup: t('block.campaign.none.signup'),
        fundraiser: t('block.campaign.none.fundraiser'),
      },
      opensOn: t('block.campaign.opensOn'),
      heading: {
        upcoming: t('block.campaign.heading.upcoming'),
        closed: t('block.campaign.heading.closed'),
      },
      act: {
        petition: t('block.campaign.act.petition'),
        signup: t('block.campaign.act.signup'),
        fundraiser: t('block.campaign.act.fundraiser'),
      },
      more: t('block.campaign.more'),
      readMore: t('block.campaign.readMore'),
      readLess: t('block.campaign.readLess'),
      readOn: t('block.campaign.readOn'),
      notOpen: {
        upcoming: t('block.campaign.notOpen.upcoming'),
        closed: t('block.campaign.notOpen.closed'),
      },
    },
    overview: {
      older: t('block.overview.older'),
      newer: t('block.overview.newer'),
      label: t('block.overview.pages'),
      restricted: t('block.overview.restricted'),
    },
  };
}
