// Form mail conformance: immutable routing/copy, recipient admission and conservative recovery.
// Existing mail send-attempt tests own provider ambiguity; these prove the form integration.
import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import { DEFAULT_ACCESS } from '../entitlements/model.js';
import {
  FakeClock,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  conditionalProbeForm,
  probeFormMail,
  probeTenant,
  TENANT,
} from '../testing/index.js';
import { formMailSource, formMailSubscriber } from './mail-delivery.js';
import { FORM_MAIL_SUBSCRIBER } from './mail-planning.js';
import { confirmationMailSource } from '../mailing/confirmation.js';
import { supporterIngestSubscriber } from '../supporters/service.js';
import { rebuildProjection } from '../supporters/model.js';
import { reconcileMail } from '../mailing/send-attempts.js';
import type { FormMailSettings } from './mail-model.js';
const FORM = '01900000-0000-7000-8000-00000000f000';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const admin = systemPrincipal(TENANT, 'form-mail-test');

describe('form mail actions', () => {
  let uow: MemoryUnitOfWork, invoker: Invoker, clock: FakeClock, mailer: MemoryMailer;
  const deps = () => ({
    uow,
    clock,
    mailer,
    from: { email: 'verified@example.org' },
    access: async () => DEFAULT_ACCESS,
    reconcileLagMs: 0,
  });
  const events = () => uow.store.outbox.filter((e) => e.type === 'form.mail.planned');
  const configure = async (value = probeFormMail(FORM), principal = admin) => {
    const state = await uow.run(admin, (ctx) => ctx.formMail.get());
    return invoker.run(useCases.updateFormMailSettings, principal, {
      baseVersion: state.version,
      value,
    });
  };
  async function submit(
    email = 'visitor@example.org',
    values: Record<string, string | boolean> = {}
  ) {
    const result = await invoker.run(useCases.submitForm, admin, {
      formId: FORM,
      locale: 'en',
      values: { email, contact_only: true, topic: 'question', message: '<b>Hello</b>', ...values },
    });
    if (result.status !== 'accepted') throw new Error(JSON.stringify(result));
    return result.submissionId;
  }
  beforeEach(async () => {
    clock = new FakeClock();
    uow = new MemoryUnitOfWork({ clock });
    invoker = new Invoker(buildRegistry(), uow);
    mailer = new MemoryMailer();
    await uow.run(admin, (ctx) => ctx.forms.insert(conditionalProbeForm(FORM)));
    await configure();
  });
  it('routes two independent conditions and pins copy before edits; repeated delivery sends once', async () => {
    const id = await submit();
    const original = events()[0]!;
    const settings = probeFormMail(FORM);
    settings.templates[0]!.text.en = 'Edited later';
    await configure(settings);
    const source = formMailSource(deps());
    expect((await source(original))?.text).toBe('Message: <b>Hello</b>');
    expect((await source(original))?.html).toContain('&lt;b&gt;Hello&lt;/b&gt;');
    const sender = formMailSubscriber(deps());
    await sender.handle(original);
    await sender.handle(original);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to.email).toBe('questions@example.org');
    expect(
      await invoker.run(useCases.getFormMailStatus, admin, { submissionId: id })
    ).toMatchObject({ actions: [{ actionId: 'question', state: 'sent', attempts: 1 }] });
    await submit('second@example.org', { topic: 'other', message: 'forged inactive' });
    const other = events()[1]!;
    expect((await source(other))?.to.email).toBe('other@example.org');
    expect((await source(other))?.text).toBe('Local other message');
    expect(events()).toHaveLength(2);
    // A copied event with a fresh id cannot create a second intent for the pinned action.
    expect(await source({ ...original, id: OTHER })).toBeNull();
  });
  it('previews the same predicates and explicitly names tenant/local/platform inheritance', async () => {
    const preview = await invoker.run(useCases.previewFormMail, admin, {
      formId: FORM,
      locale: 'en',
      values: { email: 'v@example.org', topic: 'other', contact_only: true },
    });
    expect(preview.actions).toMatchObject([
      {
        actionId: 'question',
        matches: false,
        copy: { sources: { subject: 'tenant', text: 'tenant' } },
      },
      { actionId: 'other', matches: true, copy: { sources: { subject: 'tenant', text: 'local' } } },
    ]);
    expect(events()).toHaveLength(0);
    const settings = probeFormMail(FORM);
    settings.forms[0]!.actions[0]!.template = {};
    await configure(settings);
    const platform = await invoker.run(useCases.previewFormMail, admin, {
      formId: FORM,
      locale: 'nl',
      values: { email: 'v@example.org', topic: 'question', message: 'Vraag', contact_only: true },
    });
    expect(platform.actions[0]?.copy).toMatchObject({
      subject: 'Nieuwe formulierinzending',
      sources: { subject: 'platform', text: 'platform' },
    });
  });
  it('keeps recipients private and refuses visitor routing, headers and broken typed references', async () => {
    const publicForm = await invoker.run(
      useCases.getForm,
      anonymousPrincipal(TENANT, ['forms:read']),
      { id: FORM }
    );
    expect(JSON.stringify(publicForm)).not.toContain('questions@example.org');
    await submit('visitor@example.org', { to: 'victim@example.org' });
    expect((await formMailSource(deps())(events()[0]!))?.to.email).toBe('questions@example.org');
    for (const mutate of [
      (s: FormMailSettings) => {
        s.forms[0]!.actions[0]!.recipients = ['{{field:email}}'];
      },
      (s: FormMailSettings) => {
        s.templates[0]!.subject.en = 'Subject\r\nBcc: victim@example.org';
      },
      (s: FormMailSettings) => {
        s.forms[0]!.actions[0]!.when = { op: 'equals', fieldId: 'topic', value: true };
      },
      (s: FormMailSettings) => {
        s.templates[0]!.text.en = '{{field:missing}}';
      },
    ]) {
      const settings = probeFormMail(FORM);
      mutate(settings);
      await expect(configure(settings)).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
  it('separates authoring, publishing and mail capabilities and rejects a stale settings write', async () => {
    const writer = { ...admin, capabilities: ['forms:write'] as const };
    await expect(
      configure(probeFormMail(FORM), { ...writer, capabilities: [...writer.capabilities] })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      configure(probeFormMail(FORM), { ...admin, capabilities: ['forms:write', 'mailing:send'] })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      invoker.run(useCases.updateFormMailSettings, admin, {
        baseVersion: 0,
        value: probeFormMail(FORM),
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('checks active approval, tenant status and erased submissions at dispatch and replay', async () => {
    const id = await submit();
    const event = events()[0]!;
    const settings = probeFormMail(FORM);
    settings.forms[0]!.actions[0]!.recipients = ['replacement@example.org'];
    await configure(settings);
    expect(await formMailSource(deps())(event)).toBeNull();
    await configure();
    expect(
      await formMailSource({
        ...deps(),
        access: async () => ({ ...DEFAULT_ACCESS, status: 'suspended' }),
      })(event)
    ).toBeNull();
    const otherAdmin = systemPrincipal(OTHER, 'test');
    expect(await invoker.run(useCases.getFormMailSettings, otherAdmin, {})).toMatchObject({
      version: 0,
    });
    await expect(
      invoker.run(useCases.replayFormMail, otherAdmin, { submissionId: id, eventId: event.id })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await formMailSource(deps())({ ...event, tenantId: OTHER })).toBeNull();
    uow.store.for(TENANT).submissions.delete(id);
    expect(await formMailSource(deps())(event)).toBeNull();
  });
  it('keeps unknown delivery visible and reconciles before a controlled retry with frozen copy', async () => {
    const id = await submit();
    const event = events()[0]!;
    let sends = 0,
      accepted = false;
    const uncertain = {
      async send() {
        sends++;
        throw new Error('timeout visitor@example.org');
      },
      async lookup() {
        return accepted ? { providerIds: ['accepted-1'] } : null;
      },
    };
    const delivery = { ...deps(), mailer: uncertain };
    await formMailSubscriber(delivery).handle(event);
    expect(
      await invoker.run(useCases.getFormMailStatus, admin, { submissionId: id })
    ).toMatchObject({
      actions: [
        { state: 'unknown', lastError: expect.not.stringContaining('visitor@example.org') },
      ],
    });
    await invoker.run(useCases.replayFormMail, admin, { submissionId: id, eventId: event.id });
    const message = (await formMailSource(delivery)(event))!;
    await reconcileMail(delivery, event, FORM_MAIL_SUBSCRIBER, message);
    expect(sends).toBe(1);
    accepted = true;
    await reconcileMail(delivery, event, FORM_MAIL_SUBSCRIBER, message);
    expect(sends).toBe(1);
    expect(
      await invoker.run(useCases.getFormMailStatus, admin, { submissionId: id })
    ).toMatchObject({ actions: [{ state: 'sent' }] });
    expect(
      await invoker.run(useCases.replayFormMail, admin, { submissionId: id, eventId: event.id })
    ).toEqual({ scheduled: false });
  });
  it('pins confirmation copy and retains the mandatory confirmation URL after template and form edits', async () => {
    await submit('signup@example.org', { contact_only: false, consent: true });
    const event = uow.store.outbox.find((e) => e.type === 'newsletter.subscribed')!;
    const settings = probeFormMail(FORM);
    settings.forms[0]!.confirmation!.override!.subject!.en = 'Edited';
    await configure(settings);
    const current = (await uow.run(admin, (ctx) => ctx.forms.findById(FORM)))!;
    await uow.run(admin, (ctx) =>
      ctx.forms.insert({
        ...current,
        fields: current.fields.map((f) =>
          f.name === 'message' ? { ...f, name: 'renamed_message' } : f
        ),
      })
    );
    const source = confirmationMailSource({
      ...deps(),
      signer: uow.signer,
      tenants: new MemoryTenants([probeTenant(TENANT)]),
      platform: { platformOrigin: 'https://example.org', siteUrlMode: 'path' },
    });
    const message = await source(event);
    expect(message?.subject).toBe('Pinned confirmation');
    expect(message?.text).toContain('Please confirm.');
    expect(message?.text).toContain('/confirm?token=');
    const subId = event.props['submissionId'] as string;
    uow.store.for(TENANT).submissions.delete(subId);
    expect(await source(event)).toBeNull();
  });
  it('allows one designated receipt without marketing consent and preserves the five-post cap', async () => {
    const settings = probeFormMail(FORM);
    settings.forms[0]!.actions = [
      { id: 'receipt', kind: 'receipt', enabled: true, recipients: [], template: {} },
    ];
    await configure(settings);
    await submit();
    for (let n = 0; n < 4; n++)
      expect(
        await invoker.run(useCases.submitForm, admin, {
          formId: FORM,
          locale: 'en',
          values: { email: 'visitor@example.org', contact_only: true },
        })
      ).toMatchObject({ status: 'rejected', reason: 'recipient-limited' });
    expect(events()).toHaveLength(1);
    await formMailSubscriber(deps()).handle(events()[0]!);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to.email).toBe('visitor@example.org');
    expect(uow.store.outbox.filter((e) => e.type === 'newsletter.subscribed')).toHaveLength(0);
    await submit('signup@example.org', { contact_only: false, consent: true });
    expect(events()).toHaveLength(1); // The mandatory opt-in message is the designated visitor response.
  });
  it('ignores inactive inherited-key predicates and gives equal action versions to different submissions', async () => {
    const form = conditionalProbeForm(FORM);
    form.fields.splice(2, 0, {
      id: 'constructor',
      name: 'selection',
      type: 'checkbox',
      required: false,
      label: { en: 'Selection' },
      activeWhen: { op: 'equals', fieldId: 'contact_only', value: false },
    });
    await uow.run(admin, (ctx) => ctx.forms.insert(form));
    const settings = probeFormMail(FORM);
    settings.forms[0]!.actions[0]!.when = {
      op: 'not-equals',
      fieldId: 'constructor',
      value: false,
    };
    await configure(settings);
    await submit('inactive@example.org', { selection: true });
    expect(events()).toHaveLength(0);
    await configure();
    await submit('first-version@example.org');
    await submit('second-version@example.org');
    expect(events()[0]?.props['actionVersion']).toBe(events()[1]?.props['actionVersion']);
    expect(events()[0]?.id).not.toBe(events()[1]?.id);
  });
  it('checks withdrawal again before confirmation dispatch and keeps abandoned actions unreplayable', async () => {
    await submit('withdrawn@example.org', { contact_only: false, consent: true });
    const event = uow.store.outbox.find((e) => e.type === 'newsletter.subscribed')!;
    await supporterIngestSubscriber(uow).handle(event);
    await uow.run(admin, async (ctx) => {
      const projection = (await ctx.supporters.getProjection('withdrawn@example.org'))!;
      const history = await ctx.supporters.eventsFor(projection.id);
      const withdrawn = {
        ...history[0]!,
        id: 'withdrawn',
        type: 'consent.withdrawn' as const,
        occurred_at: new Date(clock.now().getTime() + 1000).toISOString(),
      };
      await ctx.supporters.appendEvent({ ...withdrawn, supporter_id: projection.id });
      await ctx.supporters.saveProjection(rebuildProjection([...history, withdrawn])!);
    });
    const source = confirmationMailSource({
      ...deps(),
      signer: uow.signer,
      tenants: new MemoryTenants([probeTenant(TENANT)]),
      platform: { platformOrigin: 'https://example.org', siteUrlMode: 'path' },
    });
    expect(await source(event)).toBeNull();
    const mail = events()[0]!;
    await formMailSubscriber({
      ...deps(),
      mailer: {
        async send() {
          throw new Error('timeout');
        },
        async lookup() {
          return null;
        },
      },
    }).handle(mail);
    await uow.run(admin, (ctx) =>
      ctx.mailSends.abandon(`${FORM_MAIL_SUBSCRIBER}:${mail.id}`, clock.now())
    );
    expect(
      await invoker.run(useCases.replayFormMail, admin, {
        submissionId: mail.props['submissionId'] as string,
        eventId: mail.id,
      })
    ).toEqual({ scheduled: false });
  });
  it('erases whole personalised mail bodies, not only recognised email addresses', async () => {
    await submit('erase-body@example.org', {
      contact_only: false,
      consent: true,
      message: 'Private biography and phone',
    });
    const original = structuredClone(events()[0]!);
    const signup = uow.store.outbox.find((e) => e.type === 'newsletter.subscribed')!;
    await supporterIngestSubscriber(uow).handle(signup);
    await uow.run(admin, async (ctx) => {
      const supporter = (await ctx.supporters.getProjection('erase-body@example.org'))!;
      await ctx.erasures.register(supporter.id, supporter.email);
      await ctx.erasures.apply();
    });
    const erased = events()[0]!;
    expect(erased.props).toEqual({});
    expect(signup.props).not.toHaveProperty('confirmationCopy');
    expect(await formMailSource(deps())(erased)).toBeNull();
    expect(await formMailSource(deps())(original)).toBeNull();
  });
  it('does not resolve an inapplicable confirmation template for a contact-only submission', async () => {
    const settings = probeFormMail(FORM);
    settings.forms[0]!.confirmation!.override!.text!.en = '{{field:message}}';
    await configure(settings);
    await submit('contact-only@example.org', { topic: 'other' });
    expect(events()).toHaveLength(1);
    expect(uow.store.outbox.some((e) => e.type === 'newsletter.subscribed')).toBe(false);
  });
  it('enforces persistent tenant reservations and rolls them into the next UTC month', async () => {
    const limited = { ...admin, entitlements: { ...admin.entitlements, 'mail.monthly_max': 1 } };
    const input = (email: string) => ({
      formId: FORM,
      locale: 'en',
      values: { email, contact_only: true, topic: 'other' },
    });
    await invoker.run(useCases.submitForm, limited, input('first@example.org'));
    await expect(
      invoker.run(useCases.submitForm, limited, input('second@example.org'))
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    clock.advance(32 * 24 * 3600 * 1000);
    expect(
      await invoker.run(useCases.submitForm, limited, input('third@example.org'))
    ).toMatchObject({ status: 'accepted' });
  });
});
