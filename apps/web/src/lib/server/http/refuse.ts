// How a route says no: one status, one code. The error page of each route group turns the code or
// the status into catalog copy (ADR 007), so no route writes a sentence in one language and a
// request for a raw file gets a code, not prose. `forbidden`, `not_found` and `invalid_input` are
// the use-case codes `loaded` already passes on (lib/server/admin/admin-actions.ts).
// Rejected: `error(status, { key })` with an extended App.Error (the page would still have to
// handle the framework's own errors, which carry no key) and a helper per status (five names for
// one table).
//
// `refusalOf` is the other half: what a catch has when a use case said no. Anything else is a real
// failure and goes on to `handleError`, so no route writes that test itself. Rejected: `act` for
// every catch (an action that re-renders its own form or answers JSON has no use for its shape).
import { UseCaseError } from '@mycel/core';
import { error } from '@sveltejs/kit';

const CODES = {
  400: 'invalid_input',
  403: 'forbidden',
  404: 'not_found',
  429: 'too_many',
  503: 'not_configured',
} as const;

/** Stop this request with `status`; the error page says it in the visitor's language. */
export function refuse(status: keyof typeof CODES): never {
  error(status, CODES[status]);
}

/** The use case's refusal in a catch; anything else is rethrown as it was. */
export function refusalOf(e: unknown): UseCaseError {
  if (e instanceof UseCaseError) return e;
  throw e;
}
