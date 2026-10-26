// Native assistance consent mapping is shared with its regression proof using real use cases.
// Rejected: testing core alone, which cannot catch a front substituting a different provider.
import { useCases, UseCaseError, type Invoker, type Principal } from '@mycel/core';

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
