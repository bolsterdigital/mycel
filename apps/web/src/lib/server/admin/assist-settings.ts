// Native assistance consent mapping is shared with its regression proof using real use cases.
// Rejected: testing core alone, which cannot catch a front substituting a different provider.
import {
  can,
  leadCandidates,
  useCases,
  UseCaseError,
  type ContentDocument,
  type Invoker,
  type Principal,
} from '@mycel/core';

/**
 * What the edit screen offers (ADR 021): assistance at all, for a member who may ask and write on
 * a site that consented to its processor, and a lead from an article's own prose in the working
 * locale.
 */
export async function editAssist(
  invoker: Invoker,
  principal: Principal,
  type: string,
  doc: ContentDocument,
  work: string
) {
  const settings =
    can(principal, 'ai:assist') && can(principal, 'content:write')
      ? await invoker.run(useCases.getAssistSettings, principal, {})
      : null;
  const assistEnabled = !!(
    settings?.enabled &&
    settings.provider &&
    settings.consentedProvider === settings.provider &&
    principal.entitlements['ai.assist'] &&
    (doc.access.level === 'public' || settings.allowRestricted)
  );
  const leadAssist = assistEnabled && type === 'article' && leadCandidates(doc, work).length > 0;
  return { assistEnabled, leadAssist };
}

export async function saveAssistSettings(invoker: Invoker, principal: Principal, data: FormData) {
  const current = await invoker.run(useCases.getAssistSettings, principal, {});
  const enabled = data.get('enabled') === 'on';
  const provider = data.get('provider');
  const allowRestricted = data.get('allowRestricted') === 'on';
  if (enabled && (!principal.entitlements['ai.assist'] || !current.provider))
    return { status: 403, problem: 'unavailable', enabled, allowRestricted };
  if (enabled && data.get('consent') !== 'on')
    return { status: 400, problem: 'consent', enabled, allowRestricted };
  if (enabled && (typeof provider !== 'string' || provider !== current.provider))
    return { status: 400, problem: 'provider', enabled, allowRestricted };
  try {
    await invoker.run(useCases.updateAssistSettings, principal, {
      enabled,
      allowRestricted: enabled && allowRestricted,
      consentedProvider: enabled && typeof provider === 'string' ? provider : null,
    });
  } catch (e) {
    if (!(e instanceof UseCaseError)) throw e;
    return {
      status: e.code === 'forbidden' ? 403 : 400,
      problem: 'invalid',
      enabled,
      allowRestricted,
    };
  }
  return null;
}
