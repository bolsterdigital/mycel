// The picker crosses the real authoring registry, including denied reads and tenant isolation.
import { beforeEach, expect, it, vi } from 'vitest';
import {
  Block,
  Invoker,
  buildRegistry,
  systemPrincipal,
  useCases,
  type Principal,
} from '@mycel/core';
import { MemoryUnitOfWork, TENANT, conditionalProbeForm } from '@mycel/core/testing';
import { editorForms } from './editor.js';

let invoker: Invoker;
vi.mock('../runtime.js', () => ({ runtime: () => ({ invoker }) }));
const admin = systemPrincipal(TENANT, 'editor-test');
const id = '01900000-0000-7000-8000-00000000f000';
const missing = '01900000-0000-7000-8000-00000000f001';
const blocks = [
  Block.parse({ id: 'f', type: 'form', version: 1, props: { formId: id } }),
  Block.parse({ id: 's', type: 'signup-form', version: 1, props: { formId: missing } }),
];

beforeEach(async () => {
  const uow = new MemoryUnitOfWork();
  invoker = new Invoker(buildRegistry(), uow);
  await uow.run(admin, (ctx) =>
    ctx.forms.insert({ ...conditionalProbeForm(id), name: { nl: 'Meedoen', en: 'Join us' } })
  );
});

it('lists names through form.list, keeps missing ids and uses the shared locale fallback', async () => {
  const run = vi.spyOn(invoker, 'run');
  const result = await editorForms(admin, blocks, 'en', 'nl');
  expect(run).toHaveBeenCalledWith(useCases.listForms, admin, {});
  expect(result.choices).toEqual([{ id, label: 'Join us' }]);
  expect(result.definitions.get(missing)).toBeNull();
  expect((await editorForms(admin, blocks, 'fr', 'nl')).choices).toEqual([
    { id, label: 'Meedoen' },
  ]);
  const other = systemPrincipal('01900000-0000-7000-8000-000000000002', 'other');
  expect((await editorForms(other, [], 'nl', 'nl')).choices).toEqual([]);
});

it('does not list or resolve forms without forms:read, and preserves read-only rendering', async () => {
  const run = vi.spyOn(invoker, 'run');
  const author: Principal = { ...admin, capabilities: ['content:write'] };
  const result = await editorForms(author, blocks, 'nl', 'nl');
  expect(result.choices).toBeNull();
  expect(result.definitions.size).toBe(0);
  expect(run).not.toHaveBeenCalled();
  const reader: Principal = { ...admin, capabilities: ['content:read', 'forms:read'] };
  const read = await editorForms(reader, blocks, 'nl', 'nl');
  expect(read.choices).toBeNull();
  expect(read.definitions.get(id)?.name?.nl).toBe('Meedoen');
  expect(read.definitions.get(missing)).toBeNull();
  expect(run).not.toHaveBeenCalledWith(useCases.listForms, reader, {});
});
