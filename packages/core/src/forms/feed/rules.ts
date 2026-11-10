// One gate is shared by authoring previews, acceptance and worker preparation. Delivery adds
// current supporter consent; a preview is effect-free and cannot manufacture confirmed evidence.
import type { TransactionContext } from '../../ports.js';
import { active } from '../../entitlements/guards.js';
import { grants } from '../../principal.js';
import type { ConnectionFailure } from '../../connections/intents.js';
import { fieldId, predicateMatches, validPredicateReferences } from '../fields.js';
import { mailValues } from '../mail-templates.js';
import type { FormDefinition, Submission } from '../model.js';
import type { FormFeed, FormFeedState } from './model.js';

export function validFeed(form: FormDefinition, feed: FormFeed) {
  return (
    ['signup', 'petition'].includes(form.kind) &&
    feed.scope === form.list &&
    (!feed.when || validPredicateReferences(feed.when, form.fields, true)) &&
    feed.mapping.every((m) => form.fields.some((f) => fieldId(f) === m.fieldId))
  );
}
export async function feedAuthority(ctx: TransactionContext, actor: FormFeedState['actor']) {
  if (!actor) return false;
  if (actor.kind === 'system') return true;
  const rights =
    actor.kind === 'operator'
      ? (await ctx.members.get(actor.id))?.capabilities
      : (await ctx.apiKeys.list()).find((k) => k.id === actor.id && !k.revokedAt)?.capabilities;
  return !!rights && grants(rights, 'connections:configure') && grants(rights, 'content:publish');
}
export async function feedGate(
  ctx: TransactionContext,
  feed: FormFeed
): Promise<ConnectionFailure | null> {
  if (!active(ctx.principal)) return 'suspended';
  if (!feed.enabled || !feed.connectionId) return 'source';
  const c = await ctx.connections.get(feed.connectionId);
  if (!c || c.state === 'disconnected') return 'disconnected';
  if (c.state === 'paused') return 'paused';
  if (c.version !== feed.connectionVersion) return 'version';
  if (!c.hasCredential) return 'credential';
  if (
    !c.formIds.includes(feed.formId) ||
    !c.consentScopes.includes(feed.scope) ||
    c.consentAuthority !== feed.confirmationOwner ||
    (feed.confirmationOwner === 'external' && c.provider !== 'mailchimp')
  )
    return 'authorization';
  return null;
}
export function mapFeed(sub: Submission, feed: FormFeed) {
  const form = sub.evaluation?.definition;
  if (!form || !validFeed(form, feed)) return null;
  const byId = mailValues(form, sub.values);
  if (feed.when && !predicateMatches(feed.when, byId)) return null;
  if (
    !form.fields.some(
      (f) =>
        f.type === 'consent' &&
        sub.evaluation!.activeFieldIds.includes(fieldId(f)) &&
        sub.values[f.name] === true
    )
  )
    return null;
  return Object.fromEntries(
    feed.mapping
      .filter(
        (m) => Object.hasOwn(byId, m.fieldId) && sub.evaluation!.activeFieldIds.includes(m.fieldId)
      )
      .map((m) => [m.target, byId[m.fieldId]!])
  );
}
