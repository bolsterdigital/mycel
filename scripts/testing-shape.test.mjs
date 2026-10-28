// The in-memory runtime stays one factory per port (TODO #53 PR 5): `testing/memory.ts` is a
// list of exports under 300 lines and no function under packages/core/src/testing spans more
// than 150 lines, so `MemoryUnitOfWork.run` cannot grow back into one function every module
// edits. Run by `npm run lint:infra`, offline.
// Rejected: a line budget per file (a module may grow with its port; one long function is the
// shape that made the old file hard to change).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

export const FUNCTION_LIMIT = 150;
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

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = 'packages/core/src/testing';

function sources() {
  return readdirSync(join(root, dir), { recursive: true })
    .filter((name) => name.endsWith('.ts') && !/\.test\.ts$/.test(name))
    .map((name) => {
      const path = `${dir}/${name}`;
      return { path, text: readFileSync(join(root, path), 'utf8') };
    });
}

test('no function under packages/core/src/testing spans more than the limit', () => {
  assert.deepEqual(overLong(sources()), []);
});

test('testing/memory.ts stays a list of exports', () => {
  const lines = readFileSync(join(root, dir, 'memory.ts'), 'utf8').split('\n').length;
  assert.ok(lines < BARREL_LIMIT, `memory.ts has ${lines} lines, limit ${BARREL_LIMIT}`);
});

test('the check sees a long function, nested or not', () => {
  const body = Array.from({ length: FUNCTION_LIMIT }, (_, i) => `  const a${i} = ${i};`).join('\n');
  const text = `class U {\n  async run() {\n${body}\n  }\n}\nconst short = () => 1;\n`;
  assert.deepEqual(overLong([{ path: 'x.ts', text }]), [
    `x.ts: run spans ${FUNCTION_LIMIT + 2} lines, limit ${FUNCTION_LIMIT}`,
  ]);
});
