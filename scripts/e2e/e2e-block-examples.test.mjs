// The browser seed of scripts/e2e/e2e.mjs keeps each block example's registry version, name, type and
// props: a fixed version in the seed breaks as soon as a schema moves on. Run by
// `npm run lint:infra`, offline.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockExamples } from './e2e-block-examples.mjs';

test('browser seed examples preserve each registry definition version, name, type and props', () => {
  const v1 = { title: { nl: 'Bestaand', en: 'Existing' } };
  const v2 = { width: 'wide', title: { nl: 'Nieuw', en: 'New' } };
  const examples = blockExamples({
    heading: { version: 1, examples: [{ name: 'heading-default', props: v1 }] },
    faq: { version: 2, examples: [{ name: 'faq-wide-probe', props: v2 }] },
  });
  assert.deepEqual(examples, {
    'heading-default': { type: 'heading', version: 1, props: v1 },
    'faq-wide-probe': { type: 'faq', version: 2, props: v2 },
  });
  assert.strictEqual(examples['heading-default'].props, v1);
  assert.strictEqual(examples['faq-wide-probe'].props, v2);
});
