// Validate the measured document, not a separate successful health request. The browser adapter
// supplies facts from the same navigation as Lighthouse; a 200 alone proves neither identity nor
// complete resources. Rejected: trusting a high score from a login, redirect or empty page.
const normalize = (text) => text.replace(/\s+/gu, ' ').trim();
const proseText = (node) =>
  node.text ?? (node.content ?? []).map(proseText).filter(Boolean).join(' ');

// Resolve expectations from the seeded revision, never from the measured editor itself.
export function writerExpectation(document, locale) {
  return document.blocks.map((block) => ({
    id: block.id,
    type: block.type,
    ...(block.type === 'rich-text'
      ? { text: normalize(proseText(block.props.content[locale])) }
      : {}),
  }));
}

export function validateIdentity(expected, facts) {
  const reasons = [];
  if (facts.url !== expected.url) reasons.push('final-url');
  if (facts.status !== 200) reasons.push('http-status');
  if (facts.locale !== expected.locale) reasons.push('locale');
  if (!facts.csp) reasons.push('missing-production-csp');
  if (!facts.title?.includes(expected.title)) reasons.push('title');
  if (expected.indexable) {
    if (facts.noindex) reasons.push('unexpected-noindex');
    if (!facts.canonical?.endsWith(expected.canonicalSuffix)) reasons.push('canonical');
    if (facts.words < (expected.minWords ?? 1)) reasons.push('empty-content');
    if (facts.images < expected.minImages || facts.brokenImages) reasons.push('images');
    if (!facts.fonts?.includes(expected.font)) reasons.push('font');
    if (!facts.themeStylesheet) reasons.push('theme');
    if (expected.form && !facts.form) reasons.push('form');
    if (expected.article && (!facts.h2 || !facts.ul || !facts.ol || !facts.quote || !facts.link))
      reasons.push('article-structure');
  } else {
    if (!facts.noindex) reasons.push('admin-noindex');
    if (!facts.privateCache) reasons.push('admin-private-cache');
    if (facts.siteName !== 'Probe') reasons.push('tenant');
    if (!facts.authenticated) reasons.push('authentication');
    if (expected.populated && !facts.populated) reasons.push('empty-list');
    if (expected.writer && !facts.writer) reasons.push('writer');
    if (expected.item && !expected.writer && !facts.itemText) reasons.push('wrong-item');
    if (expected.writerBlocks) {
      if (JSON.stringify(facts.writerBlocks) !== JSON.stringify(expected.writerBlocks))
        reasons.push('wrong-item');
      if (!facts.writerBlocks?.some((block) => block.type === 'rich-text' && block.text?.trim()))
        reasons.push('empty-editor');
    }
  }
  // An explicit integration expectation cannot be improved away by suppressing its request.
  for (const path of expected.requiredRequests ?? [])
    if (!facts.requests?.some((url) => url.includes(path))) reasons.push(`missing-request:${path}`);
  if (facts.failedRequests?.length) reasons.push('failed-request');
  if (facts.foreignRequests?.length) reasons.push('foreign-request');
  if (facts.pageErrors?.length) reasons.push('page-error');
  return {
    valid: reasons.length === 0,
    reasons,
    noindex: facts.noindex,
    privateCache: facts.privateCache,
    functionalFailures: reasons.filter((reason) =>
      ['admin-noindex', 'admin-private-cache', 'foreign-request', 'page-error'].includes(reason)
    ),
  };
}
