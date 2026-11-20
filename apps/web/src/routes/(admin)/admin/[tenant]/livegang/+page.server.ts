// The launch checklist of a site (MY-262 PR 2, ADR 037): one `launch.checklist.get` for the
// verdict, what needs attention and the three phases, and one form per phase whose Save writes
// only the steps that changed, each through `launch.step.update`, the same use case HTTP and MCP
// expose. Works without JavaScript: a checkbox per step, a note, and owner and applicability
// behind a disclosure. A field the screen did not render for a step (the tick of a check, the
// acceptance of a check that does not warn) is not posted, and absent means "unchanged", never
// "off": the hidden `toggle-<id>` names which of the two the row showed. A phase posts every step
// it shows, so a step someone else saved after this page was read (`seen-<id>` is its `updatedAt`
// then) is left as they saved it and counted, instead of being set back to what this page showed.
// Rejected: a post per step (a phase of fourteen steps would be fourteen round trips to tick
// three) and one form for the whole list (one Save far below the step it is about).
import { useCases, type LaunchStepPatch, type LaunchStepView } from '@mycel/core';
import { act, loaded, text } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const principal = locals.principal!;
  return {
    checklist: await loaded(runtime().invoker.run(useCases.getLaunchChecklist, principal, {})),
  };
};

const OWNERS = ['platform', 'organisation', 'shared'] as const;

/** The posted state of one step, against what is stored; only the fields that differ. */
function patchOf(step: LaunchStepView, data: FormData): LaunchStepPatch | null {
  const id = step.id;
  const patch: LaunchStepPatch = { stepId: id };
  const toggle = text(data, `toggle-${id}`);
  const ticked = data.has(`tick-${id}`);
  if (toggle === 'done' && ticked !== step.done) patch.done = ticked;
  if (toggle === 'ack' && ticked !== step.acknowledged) patch.acknowledged = ticked;
  if (data.has(`note-${id}`)) {
    const note = text(data, `note-${id}`).trim();
    if (note !== step.note) patch.note = note;
  }
  if (data.has(`owner-${id}`)) {
    const posted = text(data, `owner-${id}`);
    const owner = OWNERS.find((o) => o === posted) ?? null;
    if (owner !== (step.ownerOverridden ? step.owner : null)) patch.owner = owner;
  }
  if (data.has(`applicable-${id}`)) {
    const posted = text(data, `applicable-${id}`);
    const applicable = posted === 'on' ? true : posted === 'off' ? false : null;
    if (applicable !== (step.applicableSource === 'override' ? step.applicable : null))
      patch.applicable = applicable;
  }
  return Object.keys(patch).length > 1 ? patch : null;
}

export const actions: Actions = {
  save: (event) =>
    act(event, 'save', { conflict: 'admin.launch.error.invalid' }, async (principal, data) => {
      const { invoker } = runtime();
      const current = await invoker.run(useCases.getLaunchChecklist, principal, {});
      const steps = new Map(current.phases.flatMap((p) => p.steps).map((s) => [s.id, s]));
      const posted = data.getAll('step').map(String);
      const shown = posted.map((id) => steps.get(id)).filter((s): s is LaunchStepView => !!s);
      const moved = shown.filter((s) => (s.updatedAt ?? '') !== text(data, `seen-${s.id}`));
      const patches = shown
        .filter((s) => !moved.includes(s))
        .map((s) => patchOf(s, data))
        .filter((p): p is LaunchStepPatch => !!p);
      for (const patch of patches) await invoker.run(useCases.updateLaunchStep, principal, patch);
      return {
        action: 'save',
        done: patches.length
          ? ('admin.launch.done.saved' as const)
          : ('admin.launch.done.unchanged' as const),
        n: patches.length,
        moved: moved.length,
      };
    }),
};
