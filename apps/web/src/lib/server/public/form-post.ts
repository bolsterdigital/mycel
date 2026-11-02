// What a public form post answers when `form.submit` throws (brief form-intake § 4). Three
// classes, because a visitor has to act differently on each: the site is closed (403, nothing to
// do), the post itself is broken (400, reload the page), or we failed (503, try later, with the
// request id so a support question can find the log line). Pure, so the mapping is tested without
// a server; the route does the logging and the reporting that `report` asks for. Rejected: the
// earlier catch-all 400 with "this field is required", which turned a database or config failure
// into a field error that was never reported and that the visitor retried forever.

import { UseCaseError, translate } from '@mycel/core';

export interface FormFailure {
  status: 403 | 400 | 503;
  /** Already in the visitor's locale; never text from the error itself. */
  message: string;
  /** `error`: capture and log as an error; `info`: one log line; `none`: expected, say nothing. */
  report: 'none' | 'info' | 'error';
}

export function failureFor(error: unknown, locale: string, requestId: string): FormFailure {
  if (error instanceof UseCaseError) {
    // The site takes no new signups (ADR 015 rules 3 and 7): no price, no host, just that.
    if (error.code === 'limit_exceeded' || error.code === 'suspended')
      return { status: 403, message: translate(locale, 'forms.rejected.closed'), report: 'none' };
    // Unknown or malformed formId: only a hand-crafted or stale post gets here.
    if (error.code === 'not_found' || error.code === 'invalid_input')
      return { status: 400, message: translate(locale, 'forms.error.malformed'), report: 'info' };
  }
  return {
    status: 503,
    message: translate(locale, 'forms.error.unavailable', { requestId }),
    report: 'error',
  };
}
