// One form's public definition and private actions are loaded through separate capabilities.
// Every native post goes through registry authorization, fingerprint or settings version checks.
import { can, useCases, type Principal } from '@mycel/core';
import { act, loaded, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import { checked, localizedInput, predicate, updateDefinition } from '#lib/server/forms/input.js';
import type { Actions, PageServerLoad } from './$types';
const copy = {
  conflict: 'admin.forms.conflict',
  invalid: 'admin.forms.invalid',
  notFound: 'admin.forms.missing',
} as const;
const run = () => runtime().invoker;
export const load: PageServerLoad = async ({ parent, locals, params }) => {
  await parent();
  const p = locals.principal!;
  // The authoring inventory is the capability gate, independent of public form.get.
  await loaded(run().run(useCases.listForms, p, {}));
  const definition = await loaded(run().run(useCases.getFormForAuthoring, p, { id: params.id }));
  const mail = can(p, 'mailing:read')
    ? await loaded(run().run(useCases.getFormMailSettings, p, {}))
    : null;
  const feeds = can(p, 'connections:read')
    ? await loaded(run().run(useCases.getFormFeeds, p, {}))
    : null;
  const connections = can(p, 'connections:read')
    ? (await loaded(run().run(useCases.listConnections, p, {}))).connections
    : [];
  const submissions = can(p, 'supporters:read')
    ? (await loaded(run().run(useCases.listFormSubmissions, p, { formId: params.id }))).submissions
    : [];
  const deliveries = can(p, 'mailing:read')
    ? await Promise.all(
        submissions.map(async (s) => ({
          submissionId: s.id,
          ...(await loaded(run().run(useCases.getFormMailStatus, p, { submissionId: s.id }))),
        }))
      )
    : [];
  return { definition, mail, feeds, connections, submissions, deliveries };
};
const done = () => ({ done: true });
async function mailChange(p: Principal, data: FormData, formId: string) {
  const state = await run().run(useCases.getFormMailSettings, p, {});
  const value = structuredClone(state.value),
    command = text(data, 'command'),
    id = text(data, 'id');
  if (command === 'removeTemplate') value.templates = value.templates.filter((t) => t.id !== id);
  else if (command === 'template') {
    const old = value.templates.find((t) => t.id === id);
    const template = {
      id,
      subject: localizedInput(data, 'subject', old?.subject),
      text: localizedInput(data, 'text', old?.text),
    };
    value.templates = [...value.templates.filter((t) => t.id !== id), template];
  } else {
    const config = value.forms.find((f) => f.formId === formId) ?? {
      formId,
      enabled: false,
      actions: [],
    };
    if (command === 'mailSettings') {
      config.enabled = checked(data, 'enabled');
      config.confirmation = {
        ...(text(data, 'templateId') ? { templateId: text(data, 'templateId') } : {}),
        override: {
          subject: localizedInput(data, 'subject', config.confirmation?.override?.subject),
          text: localizedInput(data, 'text', config.confirmation?.override?.text),
        },
      };
    } else if (command === 'removeAction')
      config.actions = config.actions.filter((a) => a.id !== id);
    else {
      const previous = config.actions.find((a) => a.id === id);
      const action = {
        id,
        enabled: checked(data, 'enabled'),
        kind: text(data, 'kind'),
        when: predicate(data, 'when'),
        recipients: text(data, 'recipients')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        template: {
          ...(text(data, 'templateId') ? { templateId: text(data, 'templateId') } : {}),
          override: {
            subject: localizedInput(data, 'subject', previous?.template.override?.subject),
            text: localizedInput(data, 'text', previous?.template.override?.text),
          },
        },
      };
      // Schema validation is owned by the registry, including recipient policy.
      config.actions = [
        ...config.actions.filter((a) => a.id !== id),
        action,
      ] as typeof config.actions;
    }
    value.forms = [...value.forms.filter((f) => f.formId !== formId), config];
  }
  await run().run(useCases.updateFormMailSettings, p, {
    baseVersion: Number(text(data, 'version')),
    value,
  });
  return done();
}
export const actions: Actions = {
  definition: (event) =>
    act(event, 'definition', copy, async (p, data) => {
      const { form } = await run().run(useCases.getFormForAuthoring, p, { id: event.params.id });
      await run().run(useCases.updateForm, p, {
        baseVersion: text(data, 'version'),
        value: updateDefinition(data, form),
      });
      return done();
    }),
  mail: (event) => act(event, 'mail', copy, (p, data) => mailChange(p, data, event.params.id)),
  feed: (event) =>
    act(event, 'feed', copy, async (p, data) => {
      const state = await run().run(useCases.getFormFeeds, p, {}),
        id = text(data, 'id');
      const cId = text(data, 'connectionId');
      const feed = {
        id,
        formId: event.params.id,
        enabled: checked(data, 'enabled'),
        connectionId: cId || null,
        connectionVersion: cId ? Number(text(data, 'connectionVersion')) : null,
        scope: text(data, 'scope'),
        confirmationOwner:
          text(data, 'confirmationOwner') === 'external'
            ? ('external' as const)
            : ('mycel' as const),
        operation:
          text(data, 'operation') === 'resubscribe'
            ? ('resubscribe' as const)
            : text(data, 'operation') === 'profile'
              ? ('profile' as const)
              : ('subscribe' as const),
        when: predicate(data, 'when'),
        mapping: text(data, 'mapping')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [fieldId, target] = line.split('=');
            return { fieldId: fieldId?.trim() ?? '', target: target?.trim() ?? '' };
          }),
      };
      await run().run(useCases.updateFormFeeds, p, {
        baseVersion: Number(text(data, 'version')),
        value: {
          feeds: [
            ...state.state.value.feeds.filter((f) => f.id !== id),
            ...(text(data, 'command') === 'removeFeed' ? [] : [feed]),
          ],
        },
      });
      return done();
    }),
  preview: (event) =>
    act(event, 'preview', copy, async (p, data) => {
      const { form } = await run().run(useCases.getFormForAuthoring, p, { id: event.params.id });
      const values = Object.fromEntries(
        form.fields.map((f) => [
          f.name,
          ['consent', 'checkbox'].includes(f.type)
            ? checked(data, `sample.${f.name}`)
            : f.type === 'multiple-choice'
              ? data.getAll(`sample.${f.name}`).map(String)
              : text(data, `sample.${f.name}`),
        ])
      );
      const mail = can(p, 'mailing:read')
        ? await run().run(useCases.previewFormMail, p, {
            formId: form.id,
            locale: text(data, 'locale'),
            values,
          })
        : null;
      const feeds = can(p, 'connections:configure')
        ? await run().run(useCases.getFormFeeds, p, {})
        : null;
      const results = await Promise.all(
        (feeds?.state.value.feeds.filter((f) => f.formId === form.id) ?? []).map(async (f) => ({
          id: f.id,
          ...(await run().run(useCases.testFormFeed, p, { feedId: f.id, values })),
        }))
      );
      return { preview: { mail, feeds: results } };
    }),
  replay: (event) =>
    act(event, 'replay', copy, async (p, data) => {
      // Bind replay to this form as well as the tenant, rather than accepting another form's id.
      const { submissions } = await run().run(useCases.listFormSubmissions, p, {
        formId: event.params.id,
      });
      const id = text(data, 'submissionId');
      if (!submissions.some((s) => s.id === id)) return { done: false };
      return {
        replay: await run().run(useCases.replayFormMail, p, {
          submissionId: id,
          eventId: text(data, 'eventId'),
        }),
      };
    }),
};
