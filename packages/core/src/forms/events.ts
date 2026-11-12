// Events the forms module publishes (ADR 010 rule 4). Props carry what subscribers need so that
// none of them has to read the forms tables: the supporter module builds its envelope from this.

export interface NewsletterSubscribedProps {
  supporterLifecycleId?: string | undefined;
  email: string;
  list: string;
  formId: string;
  submissionId: string;
  locale: string;
  pageUrl: string | null;
  consentTextVersion: string;
  /** False until the double opt-in link is followed. */
  confirmed: boolean;
  formVersion?: string;
  confirmationVersion?: string;
  confirmationCopy?: import('./mail-model.js').ResolvedFormMail;
}

/** Published by `mailing.opt_in.confirm` for the first click on a confirmation link, never for a second. */
export interface ConsentGivenProps {
  supporterLifecycleId?: string | undefined;
  email: string;
  list: string;
  formId: string;
  submissionId: string;
  locale: string;
  consentTextVersion: string;
  /** ISO instant; equals the event's `occurredAt`. */
  confirmedAt: string;
}

/**
 * Published by `form.submit` for a submission to a campaign's form (ADR 033 rule 7) when no
 * Mycel-owned consent confirmation covers it: without a ticked consent field, or with consent
 * whose confirmation an external provider owns. The confirmation subscriber mails the link that
 * confirms the address for the campaign; it grants no list, so a signature is never mail consent.
 */
export interface ParticipationRequestedProps extends Omit<NewsletterSubscribedProps, 'confirmed'> {
  campaignId: string;
  confirmed: false;
}

/**
 * Published by `mailing.opt_in.confirm` for the first confirmation of a submission to a campaign's
 * form: `petition.signed` for a petition, `form.submitted` for a signup. Supporter ingest records
 * the participation once the supporter id exists (ADR 033 rule 7).
 */
export interface ParticipationConfirmedProps {
  supporterLifecycleId?: string | undefined;
  email: string;
  formId: string;
  submissionId: string;
  campaignId: string;
  locale: string;
  /** ISO instant; equals the event's `occurredAt`. */
  confirmedAt: string;
}

export const PARTICIPATION_REQUESTED = 'campaign.participation.requested';
