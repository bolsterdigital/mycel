// Events the forms module publishes (ADR 010 rule 4). Props carry what subscribers need so that
// none of them has to read the forms tables: the supporter module builds its envelope from this.

export interface NewsletterSubscribedProps {
  email: string;
  list: string;
  formId: string;
  submissionId: string;
  locale: string;
  pageUrl: string | null;
  consentTextVersion: string;
  /** False until the double opt-in link is followed. */
  confirmed: boolean;
}

/** Published by `mailing.opt_in.confirm` for the first click on a confirmation link, never for a second. */
export interface ConsentGivenProps {
  email: string;
  list: string;
  formId: string;
  submissionId: string;
  locale: string;
  consentTextVersion: string;
  /** ISO instant; equals the event's `occurredAt`. */
  confirmedAt: string;
}
