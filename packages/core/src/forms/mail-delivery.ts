// Form actions share transactional delivery and conservative recovery with opt-in mail.
// Rejected: sending in form.submit or retrying a timeout as if it proved non-delivery.
import type { Subscriber } from '../ports.js';
import { systemPrincipal } from '../principal.js';
import type { TenantAccess } from '../entitlements/model.js';
import { entitled } from '../entitlements/guards.js';
import { sendOnce, type DeliveryDeps, type MailSource } from '../mailing/send-attempts.js';
import type { MailAddress } from '../mailing/ports.js';
import { FORM_MAIL_SUBSCRIBER, formMailAllowed, type FormMailEventProps } from './mail-planning.js';

export interface FormMailDeliveryDeps extends DeliveryDeps {
  from: MailAddress;
  access(tenantId: string): Promise<TenantAccess>;
}
const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function formMailSource(deps: FormMailDeliveryDeps): MailSource {
  return async (event) => {
    if (event.type !== 'form.mail.planned') return null;
    const p = event.props as unknown as FormMailEventProps;
    if (typeof p.submissionId !== 'string' || typeof p.email !== 'string' || !p.copy) return null;
    const access = await deps.access(event.tenantId);
    const principal = systemPrincipal(event.tenantId, FORM_MAIL_SUBSCRIBER, access);
    if (access.status === 'suspended' || !entitled(principal, 'mailing.enabled')) return null;
    if (!(await deps.uow.run(principal, (ctx) => formMailAllowed(ctx, p, event.id)))) return null;
    return {
      from: deps.from,
      to: { email: p.recipient },
      subject: p.copy.subject,
      text: p.copy.text,
      html: `<!doctype html><html lang="${escape(p.locale)}"><head><meta charset="utf-8"><title>${escape(p.copy.subject)}</title></head><body><p>${escape(p.copy.text).replace(/\n/g, '<br>')}</p></body></html>`,
      stream: 'transactional',
    };
  };
}
export function formMailSubscriber(deps: FormMailDeliveryDeps): Subscriber {
  const source = formMailSource(deps);
  return {
    name: FORM_MAIL_SUBSCRIBER,
    types: ['form.mail.planned'],
    async handle(event) {
      const message = await source(event);
      if (message) await sendOnce(deps, event, FORM_MAIL_SUBSCRIBER, message);
    },
  };
}
