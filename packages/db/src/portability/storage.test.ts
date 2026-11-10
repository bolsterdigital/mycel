// The storage catalog without a database: every name it gives exists, and no entry is a label
// without a route. The live-schema halves are in storage.conformance.test.ts (every relation and
// person-shaped column), rls.conformance.test.ts (owner `tenant` behind forced RLS) and
// erasures.conformance.test.ts (the `apply` copies against the eraser's grants and the fixture).
// Rejected: checking prose against the docs, which proves the words and not the code.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobPayloads, useCases } from '@mycel/core';
import { TABLES } from './export.js';
import {
  OFF_TABLE_STORAGE,
  OPEN_WORK,
  STORAGE,
  type Copy,
  type Retention,
  type StorageEntry,
} from './storage.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const useCaseNames = new Set<string>(Object.values(useCases).map((u) => u.name));
const jobTypes = new Set<string>(Object.keys(JobPayloads));
const entries: [string, Omit<StorageEntry, 'category'>][] = [
  ...Object.entries(STORAGE),
  ...Object.entries(OFF_TABLE_STORAGE),
];

function routeProblems(copy: Copy): string[] {
  const r = copy.route;
  switch (r.kind) {
    case 'apply':
      return r.does.trim() ? [] : ['apply without what it does'];
    case 'use-case':
      return r.useCases.length === 0
        ? ['use-case route without a use case']
        : r.useCases.filter((n) => !useCaseNames.has(n)).map((n) => `no use case ${n}`);
    case 'expires':
      return r.why.trim() ? [] : ['expires without why'];
    case 'planned':
      return r.open in OPEN_WORK ? [] : [`planned for unknown work ${r.open}`];
    case 'excluded':
      return r.reason.trim().length >= 20 ? [] : ['excluded without a reason'];
  }
}

function retentionProblems(r: Retention): string[] {
  switch (r.kind) {
    case 'term':
      return jobTypes.has(r.by) || useCaseNames.has(r.by) || existsSync(resolve(ROOT, r.by))
        ? []
        : [`term enforced by unknown ${r.by}`];
    case 'kept':
      return r.why.trim() ? [] : ['kept without why'];
    case 'planned':
      return r.open in OPEN_WORK ? [] : [`planned term for unknown work ${r.open}`];
  }
}

describe('storage catalog', () => {
  it('has an entry for exactly the tables of TABLES', () => {
    expect(Object.keys(STORAGE).sort()).toEqual(Object.keys(TABLES).sort());
  });

  it('names only use cases, jobs, files and open items that exist', () => {
    const problems = entries.flatMap(([name, e]) => [
      ...e.copies.flatMap((c) => routeProblems(c).map((p) => `${name}.${c.field}: ${p}`)),
      ...retentionProblems(e.retention).map((p) => `${name}: ${p}`),
    ]);
    expect(problems).toEqual([]);
  });

  it('lets a copy expire only where the entry has a term that removes it', () => {
    const failing = entries
      .filter(([, e]) => e.copies.some((c) => c.route.kind === 'expires'))
      .filter(([, e]) => e.retention.kind !== 'term')
      .map(([name]) => name);
    expect(failing).toEqual([]);
  });

  it('keeps an erased supporter only where a reason or an apply says so', () => {
    // A supporter copy is what ADR 019 rule 8 promises to erase: no ordinary edit, no open plan.
    const failing = entries.flatMap(([name, e]) =>
      e.copies
        .filter((c) => c.subject === 'supporter')
        .filter((c) => !['apply', 'excluded', 'expires'].includes(c.route.kind))
        .map((c) => `${name}.${c.field}`)
    );
    expect(failing).toEqual([]);
  });

  it('names every open work it lists, and lists no work nothing waits for', () => {
    const named = new Set(
      entries.flatMap(([, e]) => [
        ...e.copies.flatMap((c) => (c.route.kind === 'planned' ? [c.route.open] : [])),
        ...(e.retention.kind === 'planned' ? [e.retention.open] : []),
      ])
    );
    expect([...named].sort()).toEqual(Object.keys(OPEN_WORK).sort());
  });

  it('lists each field once per subject', () => {
    const seen = entries.flatMap(([name, e]) =>
      e.copies.map((c) => `${name}.${c.field}:${c.subject}:${c.route.kind}`)
    );
    expect(seen.length).toBe(new Set(seen).size);
  });
});
