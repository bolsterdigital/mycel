// These are adversarial DOM/network facts, shared by the runner and evaluator tests. Product
// rendering and resource expectations remain covered by the existing quality-corpus browser gate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateIdentity } from './identity.mjs';
const expected = {
  url: 'https://localhost/probe/articles/story',
  locale: 'nl',
  title: 'Story',
  indexable: true,
  canonicalSuffix: '/articles/story',
  minWords: 2000,
  minImages: 4,
  font: 'Inter',
  article: true,
};
const good = {
  url: expected.url,
  status: 200,
  locale: 'nl',
  title: 'Story',
  csp: true,
  canonical: 'https://probe.localhost/articles/story',
  words: 2100,
  images: 4,
  brokenImages: 0,
  fonts: ['Inter'],
  themeStylesheet: true,
  h2: true,
  ul: true,
  ol: true,
  quote: true,
  link: true,
  requests: ['/font.woff2'],
  failedRequests: [],
  foreignRequests: [],
  pageErrors: [],
};
test('complete measured document passes and every required identity dimension rejects drift', () => {
  assert.equal(validateIdentity(expected, good).valid, true);
  for (const [key, value] of Object.entries({
    url: '/admin/login',
    status: 404,
    locale: 'en',
    title: 'Login',
    csp: false,
    canonical: '/other',
    words: 0,
    images: 0,
    brokenImages: 1,
    fonts: [],
    themeStylesheet: false,
    h2: false,
    ul: false,
    ol: false,
    quote: false,
    link: false,
    noindex: true,
    failedRequests: ['/media/broken'],
    foreignRequests: ['https://tracker.test'],
    pageErrors: ['uncaught error'],
  })) {
    assert.equal(validateIdentity(expected, { ...good, [key]: value }).valid, false, key);
  }
});
test('form and enabled integration are part of identity, not optional score improvements', () => {
  assert.equal(validateIdentity({ ...expected, form: true }, good).valid, false);
  assert.equal(
    validateIdentity({ ...expected, requiredRequests: ['/embed.js'] }, good).valid,
    false
  );
});
test('authenticated admin requires private noindex populated tenant state', () => {
  const admin = { ...expected, indexable: false, populated: true, writer: true };
  const facts = {
    ...good,
    noindex: true,
    privateCache: true,
    siteName: 'Probe',
    authenticated: true,
    populated: true,
    writer: true,
  };
  assert.equal(validateIdentity(admin, facts).valid, true);
  for (const key of ['noindex', 'privateCache', 'authenticated', 'populated', 'writer'])
    assert.equal(validateIdentity(admin, { ...facts, [key]: false }).valid, false, key);
  assert.equal(validateIdentity(admin, { ...facts, siteName: 'Other tenant' }).valid, false);
});

test('writer uses seeded block identity and body, without requiring the document title', () => {
  const writerBlocks = [
    { id: 'prose-id', type: 'rich-text', text: 'Een gedeelde straat Bewoners bespreken bomen.' },
    { id: 'image-id', type: 'image' },
  ];
  const admin = {
    ...expected,
    title: '',
    indexable: false,
    item: true,
    writer: true,
    writerBlocks,
  };
  const facts = {
    ...good,
    title: 'Artikel schrijven',
    noindex: true,
    privateCache: true,
    siteName: 'Probe',
    authenticated: true,
    writer: true,
    itemText: false,
    writerBlocks,
  };
  assert.equal(validateIdentity(admin, facts).valid, true);
  for (const changed of [
    { url: expected.url + '/other' },
    { writerBlocks: [{ ...writerBlocks[0], id: 'another-article' }, writerBlocks[1]] },
    { writerBlocks: [{ ...writerBlocks[0], text: 'Another article body' }, writerBlocks[1]] },
    { writerBlocks: [{ ...writerBlocks[0], text: '' }, writerBlocks[1]] },
    { writerBlocks: [] },
    { writer: false, writerBlocks: undefined },
  ])
    assert.equal(validateIdentity(admin, { ...facts, ...changed }).valid, false);
  assert.ok(
    validateIdentity(admin, { ...facts, writerBlocks: [] }).reasons.includes('empty-editor')
  );
  assert.ok(validateIdentity({ ...admin, writer: false }, facts).reasons.includes('wrong-item'));
});
