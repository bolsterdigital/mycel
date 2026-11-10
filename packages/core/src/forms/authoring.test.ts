// Authoring regressions cover capability separation, stale saves and immutable accepted history.
import { beforeEach, describe, it, expect } from 'vitest';
import { Invoker } from '../invoke.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { systemPrincipal, anonymousPrincipal, type Principal } from '../principal.js';
import { MemoryUnitOfWork, TENANT, conditionalProbeForm, probeFormMail } from '../testing/index.js';
const id = '01900000-0000-7000-8000-00000000f000';
const admin = systemPrincipal(TENANT, 'authoring-test');
describe('form authoring', () => {
  let uow: MemoryUnitOfWork, invoker: Invoker;
  beforeEach(async () => {
    uow = new MemoryUnitOfWork();
    invoker = new Invoker(buildRegistry(), uow);
    await uow.run(admin, (ctx) => ctx.forms.insert(conditionalProbeForm(id)));
  });
  it('requires authoring and publishing, not anonymous submission permission', async () => {
    const publicWriter = anonymousPrincipal(TENANT, ['forms:read', 'forms:write']);
    await expect(
      invoker.run(useCases.createForm, publicWriter, { kind: 'contact' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const author: Principal = { ...admin, capabilities: ['content:write'] };
    await expect(
      invoker.run(useCases.createForm, author, { kind: 'contact' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const created = await invoker.run(useCases.createForm, admin, { kind: 'signup' });
    expect(created.fields.map((f) => f.id)).toEqual(['email', 'consent']);
  });
  it('retains ids, conflicts on stale saves and leaves accepted snapshots unchanged', async () => {
    const accepted = await invoker.run(useCases.submitForm, admin, {
      formId: id,
      locale: 'en',
      values: { email: 'a@example.org', contact_only: true, topic: 'question', message: 'Hello' },
    });
    expect(accepted.status).toBe('accepted');
    const original = await invoker.run(useCases.getForm, admin, { id });
    const value = structuredClone(original.form);
    value.fields[0]!.label.en = 'Changed';
    await invoker.run(useCases.updateForm, admin, { baseVersion: original.version, value });
    await expect(
      invoker.run(useCases.updateForm, admin, {
        baseVersion: original.version,
        value: original.form,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    if (accepted.status !== 'accepted') throw new Error('fixture');
    const stored = await uow.run(admin, (c) => c.submissions.findById(accepted.submissionId));
    expect(stored?.evaluation?.definition.fields[0]?.label.en).toBe(
      original.form.fields[0]?.label.en
    );
    const listed = await invoker.run(useCases.listFormSubmissions, admin, { formId: id });
    expect(JSON.stringify(listed)).not.toContain('a@example.org');
    expect(listed.submissions[0]?.version).toBe(original.version);
  });
  it('refuses edits that break configured mail references and isolates tenants', async () => {
    await invoker.run(useCases.updateFormMailSettings, admin, {
      baseVersion: 0,
      value: probeFormMail(id),
    });
    const original = await invoker.run(useCases.getForm, admin, { id });
    const value = {
      ...original.form,
      fields: original.form.fields.filter((f) => f.name !== 'message'),
    };
    await expect(
      invoker.run(useCases.updateForm, admin, { baseVersion: original.version, value })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const other = systemPrincipal('01900000-0000-7000-8000-00000000bbbb', 'test');
    expect(await invoker.run(useCases.listForms, other, {})).toEqual({ forms: [] });
    await expect(
      invoker.run(useCases.listFormSubmissions, other, { formId: id })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
