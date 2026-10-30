// An operator's own preferences for the admin (TODO #88): the language of its buttons and menus,
// the time zone it reads and types times in, and whether lists show relative or full dates.
// They belong to the person, not to a tenant, so they hold on every site they are a member of
// and are never part of a tenant export.
//
// They are read and written through `IdentityStore`, keyed by the operator id of a verified
// session, like `operatorPrincipal`: `operators` is platform data that only `mycel_auth` writes
// (ADR 011 rule 1). Rejected: a registry use case, which runs in one tenant's transaction as
// `mycel_app` (no write right on `operators`) and would be an MCP tool no API key or agent could
// ever use, since only an operator has preferences.

import { z } from 'zod';
import { IanaTimeZone } from '../util/time-zone.js';
import type { IdentityStore } from './ports.js';

export const ADMIN_UI_LOCALES = ['nl', 'en'] as const;

export const OperatorPreferences = z
  .object({
    /** `null`: follow the browser (`Accept-Language`). */
    uiLocale: z.enum(ADMIN_UI_LOCALES).nullable(),
    /** `null`: the time zone of the site being worked on. */
    timeZone: IanaTimeZone.nullable(),
    dateFormat: z.enum(['relative', 'absolute']),
  })
  .strict();
export type OperatorPreferences = z.infer<typeof OperatorPreferences>;

export const DEFAULT_OPERATOR_PREFERENCES: OperatorPreferences = {
  uiLocale: null,
  timeZone: null,
  dateFormat: 'relative',
};

/** The preferences of the operator a session names; the defaults for one without a row. */
export const operatorPreferences = (
  identity: IdentityStore,
  operatorId: string
): Promise<OperatorPreferences> => identity.preferencesOf(operatorId);

/**
 * Replace the preferences of the operator a session names. The id comes from the session, never
 * from a form, so nobody can set another operator's preferences. Throws a `ZodError` for an
 * invalid value; the caller shows it next to the field.
 */
export async function updateOperatorPreferences(
  identity: IdentityStore,
  operatorId: string,
  input: unknown
): Promise<OperatorPreferences> {
  const preferences = OperatorPreferences.parse(input);
  await identity.setPreferences(operatorId, preferences);
  return preferences;
}
