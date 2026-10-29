// The in-memory runtime stays one factory per port (TODO #53 PR 5): `testing/memory.ts` is a
// list of exports under 300 lines and no function under packages/core/src/testing spans more
// than 150 lines, so `MemoryUnitOfWork.run` cannot grow back into one function every module
// edits. And testing.md rule 3 stays in one place (TODO #75): only
// `packages/core/src/testing/services.ts` compares `E2E_REQUIRED`; a suite asks
// `requireServices` or `requireDatabase`. Run by `npm run lint:infra`, offline.
// Rejected: a line budget per file (a module may grow with its port; one long function is the
// shape that made the old file hard to change).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { isTest, readAll, walk } from './lib/repo.mjs';

export const FUNCTION_LIMIT = 150;
export const SKIP_RULE_HOME = 'packages/core/src/testing/services.ts';
export const BARREL_LIMIT = 300;

/** `[{ name, lines }]` for every function, method, accessor or arrow in `text`. */
export function functionSpans(path, text) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const spans = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      const line = (pos) => file.getLineAndCharacterOfPosition(pos).line;
      const name = node.name?.getText(file) ?? `<anonymous>:${line(node.getStart(file)) + 1}`;
      spans.push({ name, lines: line(node.getEnd()) - line(node.getStart(file)) + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return spans;
}

/** Functions over the limit, as messages. */
export function overLong(files, limit = FUNCTION_LIMIT) {
  return files.flatMap(({ path, text }) =>
    functionSpans(path, text)
      .filter(({ lines }) => lines > limit)
      .map(({ name, lines }) => `${path}: ${name} spans ${lines} lines, limit ${limit}`)
  );
}

/** Files other than the rule's home that compare `E2E_REQUIRED` themselves. */
export function ownSkipRules(files) {
  const compare = /E2E_REQUIRED['"]?\]?\s*[!=]==/;
  return files
    .filter(({ path, text }) => path !== SKIP_RULE_HOME && compare.test(text))
    .map(
      ({ path }) => `${path} compares E2E_REQUIRED itself; use requireServices or requireDatabase`
    );
}

const dir = 'packages/core/src/testing';
const sources = () => readAll(walk(dir, { match: (p) => p.endsWith('.ts') && !isTest(p) }));

test('no function under packages/core/src/testing spans more than the limit', () => {
  assert.deepEqual(overLong(sources()), []);
});

test('only the testing helper compares E2E_REQUIRED', () => {
  assert.deepEqual(
    ownSkipRules(
      readAll(['packages', 'apps'].flatMap((top) => walk(top, { match: (p) => p.endsWith('.ts') })))
    ),
    []
  );
});

test('the check sees a suite that compares E2E_REQUIRED itself', () => {
  const text = "if (process.env['E2E_REQUIRED'] === '1' && !url) throw new Error('x');";
  assert.deepEqual(ownSkipRules([{ path: 'packages/db/src/x.test.ts', text }]), [
    'packages/db/src/x.test.ts compares E2E_REQUIRED itself; use requireServices or requireDatabase',
  ]);
  assert.deepEqual(ownSkipRules([{ path: SKIP_RULE_HOME, text }]), []);
  assert.deepEqual(
    ownSkipRules([{ path: 'a.ts', text: "E2E_REQUIRED: 'test harness (CI)'," }]),
    []
  );
});

test('testing/memory.ts stays a list of exports', () => {
  const lines = readAll([`${dir}/memory.ts`])[0].text.split('\n').length;
  assert.ok(lines < BARREL_LIMIT, `memory.ts has ${lines} lines, limit ${BARREL_LIMIT}`);
});

test('the check sees a long function, nested or not', () => {
  const body = Array.from({ length: FUNCTION_LIMIT }, (_, i) => `  const a${i} = ${i};`).join('\n');
  const text = `class U {\n  async run() {\n${body}\n  }\n}\nconst short = () => 1;\n`;
  assert.deepEqual(overLong([{ path: 'x.ts', text }]), [
    `x.ts: run spans ${FUNCTION_LIMIT + 2} lines, limit ${FUNCTION_LIMIT}`,
  ]);
});
