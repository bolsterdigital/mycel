// The identity gatherer reads markup by selector; this ties the populated-list selector to the
// content list page and the search-result selector to the search page, so a markup change fails
// here instead of as `empty-list` or `empty-results` in a run. Rendering it would need the whole app; the browser gate covers that.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { POPULATED_ROW, SEARCH_RESULT } from './gatherer.mjs';

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

const search = readFileSync(
  new URL(
    '../../apps/web/src/routes/(public)/[tenant]/[[locale=locale]]/search/+page.svelte',
    import.meta.url
  ),
  'utf8'
);

test('search-result selector matches the search page markup', () => {
  assert.equal(SEARCH_RESULT, '.search-results > li');
  assert.match(search, /<ol class="search-results"[^>]*>\s*\{#each [^}]+\}\s*<li>/u);
});
