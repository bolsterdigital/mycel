// The identity gatherer reads admin markup by selector; this ties the populated-list selector
// to the content list page, so a markup change fails here instead of as `empty-list` in a
// weekly run. Rendering it would need the whole app; the browser gate covers that.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { POPULATED_ROW } from './gatherer.mjs';

const page = readFileSync(
  new URL('../../apps/web/src/routes/(admin)/admin/[tenant]/content/+page.svelte', import.meta.url),
  'utf8'
);
const table = readFileSync(
  new URL('../../apps/web/src/lib/admin/ui/display/Table.svelte', import.meta.url),
  'utf8'
);

test('populated-list selector matches the content list markup', () => {
  assert.equal(POPULATED_ROW, '#content-table tbody tr[id^="item-"]');
  assert.match(page, /<Table\s+id="content-table"/u);
  assert.match(page, /<tr id="item-\{item\.id\}">/u);
  assert.match(table, /<table [^>]*\{id\}>/u);
  assert.match(table, /<tbody>\{@render rows\(\)\}<\/tbody>/u);
});
